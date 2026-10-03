package relay_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
)

var (
	binaryOnce sync.Once
	binaryPath string
	binaryErr  error
)

func relayBinary(t *testing.T) string {
	t.Helper()
	binaryOnce.Do(func() {
		if p := os.Getenv("RELAY_BINARY"); p != "" {
			binaryPath = p
			return
		}
		dir, err := os.MkdirTemp("", "passio-relay-test")
		if err != nil {
			binaryErr = err
			return
		}
		binaryPath = filepath.Join(dir, "relay")
		cmd := exec.Command("go", "build", "-o", binaryPath, "../../cmd/relay")
		if out, err := cmd.CombinedOutput(); err != nil {
			binaryErr = err
			binaryPath = string(out)
		}
	})
	if binaryErr != nil {
		t.Fatalf("build relay: %v %s", binaryErr, binaryPath)
	}
	return binaryPath
}

type relayProcess struct {
	cmd    *exec.Cmd
	WS     string
	HTTP   string
	stderr chan string
	exited chan error
}

func spawnRelay(t *testing.T, env ...string) *relayProcess {
	t.Helper()
	cmd := exec.Command(relayBinary(t))
	cmd.Env = append(os.Environ(), "RELAY_ADDR=127.0.0.1:0")
	cmd.Env = append(cmd.Env, env...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &relayProcess{cmd: cmd, stderr: make(chan string, 256), exited: make(chan error, 1)}
	t.Cleanup(func() {
		cmd.Process.Signal(syscall.SIGKILL)
		<-p.exited
	})
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			select {
			case p.stderr <- sc.Text():
			default:
			}
		}
	}()
	var line struct {
		Event   string `json:"event"`
		Address string `json:"address"`
	}
	stdoutReader := bufio.NewReader(stdout)
	raw, err := stdoutReader.ReadString('\n')
	if err != nil || json.Unmarshal([]byte(raw), &line) != nil || line.Event != "listening" {
		t.Fatalf("bad startup line %q: %v", raw, err)
	}
	go func() {
		io.Copy(io.Discard, stdoutReader)
		p.exited <- cmd.Wait()
	}()
	p.WS = "ws://" + line.Address
	p.HTTP = "http://" + line.Address
	return p
}

func (p *relayProcess) waitStderr(t *testing.T, substr string) {
	t.Helper()
	timer := time.After(deadline)
	for {
		select {
		case line := <-p.stderr:
			if strings.Contains(line, substr) {
				return
			}
		case <-timer:
			t.Fatalf("stderr never contained %q", substr)
		}
	}
}

func (p *relayProcess) waitExit(t *testing.T, within time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	select {
	case err := <-p.exited:
		if err != nil {
			t.Fatalf("relay exited with error: %v", err)
		}
		p.exited <- nil
		return time.Since(start)
	case <-time.After(within):
		t.Fatalf("relay did not exit within %s", within)
		return 0
	}
}

func TestGracefulShutdownLetsActivePairsFinish(t *testing.T) {
	p := spawnRelay(t, "RELAY_PAIR_TIMEOUT_MS=1500")
	r := &testRelay{WS: p.WS, HTTP: p.HTTP}
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)
	pendingClient := mustConnect(t, r, h.Identity.EndpointID)
	if _, err := h.WaitEvent(ctx(t), "incoming", ""); err != nil {
		t.Fatal(err)
	}

	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	p.waitStderr(t, "draining")
	if code := getJSON(t, p.HTTP+"/healthz", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("healthz during drain %d", code)
	}
	if _, status := dialStatus(t, endpoint.ConnectURL(p.WS, h.Identity.EndpointID)); status != http.StatusServiceUnavailable {
		t.Fatalf("connect during drain %d", status)
	}
	if _, status := dialStatus(t, endpoint.ControlURL(p.WS, endpoint.NewIdentity().PublicKeyParam())); status != http.StatusServiceUnavailable {
		t.Fatalf("control during drain %d", status)
	}
	if err := client.WriteMessage(websocket.TextMessage, []byte("during drain")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.TextMessage, []byte("during drain"))

	endpoint.CloseWith(client, websocket.CloseNormalClosure, "done")
	expectClose(t, hostData, websocket.CloseNormalClosure)
	expectClose(t, pendingClient, websocket.CloseTryAgainLater)
	elapsed := p.waitExit(t, 10*time.Second)
	if elapsed > 4*time.Second {
		t.Fatalf("exit took %s after pairs finished", elapsed)
	}
	select {
	case <-h.ReadErr:
	case <-time.After(deadline):
		t.Fatal("control socket should be closed")
	}
}

func TestGracefulShutdownForcesCloseAfterTimeout(t *testing.T) {
	p := spawnRelay(t)
	r := &testRelay{WS: p.WS, HTTP: p.HTTP}
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)
	start := time.Now()
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	p.waitStderr(t, "draining")
	expectCloseWithin(t, client, websocket.CloseGoingAway, 10*time.Second)
	expectCloseWithin(t, hostData, websocket.CloseGoingAway, 10*time.Second)
	p.waitExit(t, 10*time.Second)
	if total := time.Since(start); total < 4*time.Second || total > 9*time.Second {
		t.Fatalf("forced shutdown took %s, expected about 5s", total)
	}
}
