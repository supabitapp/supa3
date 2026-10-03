package fixture

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Process struct {
	Cmd      *exec.Cmd
	Address  string
	Draining chan struct{}
	Done     chan struct{}
	mu       sync.Mutex
	lines    []string
	err      error
}

func Start(binary string, values map[string]string) (*Process, error) {
	return StartArgs(binary, values)
}

func StartArgs(binary string, values map[string]string, args ...string) (*Process, error) {
	cmd := exec.Command(binary, args...)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "RELAY_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "RELAY_ADDR=127.0.0.1:0")
	for k, v := range values {
		if k != "RELAY_ADDR" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	p := &Process{Cmd: cmd, Draining: make(chan struct{}), Done: make(chan struct{})}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	linesDone := make(chan struct{})
	go func() {
		defer close(linesDone)
		scanner := bufio.NewScanner(stderr)
		for scanner.Scan() {
			line := scanner.Text()
			p.mu.Lock()
			p.lines = append(p.lines, line)
			p.mu.Unlock()
			if line == `{"event":"draining"}` {
				close(p.Draining)
			}
		}
	}()
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			var event struct{ Event, Address string }
			if json.Unmarshal(scanner.Bytes(), &event) == nil && event.Event == "listening" {
				ready <- event.Address
			}
		}
	}()
	go func() {
		<-linesDone
		p.err = cmd.Wait()
		close(p.Done)
	}()
	select {
	case p.Address = <-ready:
		return p, nil
	case <-p.Done:
		return nil, fmt.Errorf("relay startup failed: %s", p.Log())
	case <-time.After(10 * time.Second):
		cmd.Process.Kill()
		<-p.Done
		return nil, errors.New("relay startup timeout")
	}
}

func (p *Process) Log() string { p.mu.Lock(); defer p.mu.Unlock(); return strings.Join(p.lines, "\n") }

func (p *Process) Stop() error {
	select {
	case <-p.Done:
		return p.err
	default:
	}
	p.Cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.Done:
		return p.err
	case <-time.After(8 * time.Second):
		p.Cmd.Process.Kill()
		<-p.Done
		return errors.New("relay shutdown timeout")
	}
}
