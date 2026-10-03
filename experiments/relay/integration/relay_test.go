package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"passio/relay/internal/fixture"

	"github.com/gorilla/websocket"
)

func deadline(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func start(t *testing.T, env map[string]string) *fixture.Process {
	t.Helper()
	binary := os.Getenv("RELAY_TEST_BINARY")
	if binary == "" {
		t.Fatal("run test.sh to supply the race-enabled relay")
	}
	if env == nil {
		env = map[string]string{}
	}
	if _, ok := env["RELAY_ADMISSION_RATE"]; !ok {
		env["RELAY_ADMISSION_RATE"] = "100000"
	}
	p, err := fixture.Start(binary, env)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Stop(); err != nil {
			t.Errorf("relay exit: %v\n%s", err, p.Log())
		}
		if strings.Contains(p.Log(), "DATA RACE") {
			t.Error(p.Log())
		}
	})
	return p
}

func host(t *testing.T, p *fixture.Process, key ed25519.PrivateKey) *fixture.Host {
	t.Helper()
	h, err := fixture.Register(p.Address, key)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.Control.Close() })
	return h
}

func pairSockets(t *testing.T, h *fixture.Host) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	c, a, err := h.Pair(deadline(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close(); a.Close() })
	return c, a
}

func read(t *testing.T, c *websocket.Conn, kind int, body []byte) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(8 * time.Second))
	k, b, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	if k != kind || !bytes.Equal(b, body) {
		t.Fatalf("payload mismatch: kind=%d length=%d", k, len(b))
	}
}

func write(t *testing.T, c *websocket.Conn, kind int, body []byte) {
	t.Helper()
	c.SetWriteDeadline(time.Now().Add(8 * time.Second))
	if err := c.WriteMessage(kind, body); err != nil {
		t.Fatal(err)
	}
}

func closed(t *testing.T, c *websocket.Conn, codes ...int) *websocket.CloseError {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(8 * time.Second))
	for {
		_, _, err := c.ReadMessage()
		if err == nil {
			continue
		}
		var ce *websocket.CloseError
		if !errors.As(err, &ce) {
			t.Fatalf("expected close, got %v", err)
		}
		for _, code := range codes {
			if ce.Code == code {
				return ce
			}
		}
		t.Fatalf("close code %d outside %v", ce.Code, codes)
	}
}

func event(t *testing.T, h *fixture.Host, kind string) fixture.Record {
	t.Helper()
	r, err := h.Next(deadline(t), kind)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func metrics(t *testing.T, p *fixture.Process) map[string]uint64 {
	t.Helper()
	client := &http.Client{Timeout: 3 * time.Second}
	r, err := client.Get("http://" + p.Address + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var m map[string]uint64
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"activeHosts", "activePairs", "pendingPairs", "forwardedMessages", "forwardedBytes", "rejectedConnections"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing metric %s", k)
		}
	}
	return m
}

func authSocket(t *testing.T, p *fixture.Process, key ed25519.PrivateKey) (*websocket.Conn, fixture.Record) {
	t.Helper()
	c, _, err := fixture.Dial(p.Address, "/v1/control", url.Values{"publicKey": {fixture.Encode(key.Public().(ed25519.PublicKey))}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	var r fixture.Record
	if err := c.ReadJSON(&r); err != nil {
		t.Fatal(err)
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(r.Nonce)
	if r.Type != "challenge" || err != nil || len(b) != 32 {
		t.Fatal("invalid challenge")
	}
	return c, r
}

func TestRegistrationAndIdentity(t *testing.T) {
	p := start(t, nil)
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	h := host(t, p, key)
	c, a := pairSockets(t, h)
	_, thief, _ := ed25519.GenerateKey(rand.Reader)
	for _, kind := range []string{"invalid", "missing", "stolen", "duplicate", "replay"} {
		t.Run(kind, func(t *testing.T) {
			socket, challenge := authSocket(t, p, key)
			signed := []byte("passio-relay-v1\n" + h.ID + "\n" + challenge.Nonce)
			signature := ed25519.Sign(key, signed)
			switch kind {
			case "invalid":
				signature[0] ^= 1
			case "missing":
				signature = nil
			case "stolen":
				signature = ed25519.Sign(thief, signed)
			case "replay":
				socket.Close()
				socket, _ = authSocket(t, p, key)
			}
			socket.WriteJSON(map[string]string{"type": "authenticate", "signature": fixture.Encode(signature)})
			closed(t, socket, 1008)
			write(t, c, 1, []byte(kind))
			read(t, a, 1, []byte(kind))
		})
	}
	for _, encoded := range []string{"", fixture.Encode(key.Public().(ed25519.PublicKey)) + "=", "!"} {
		c, status, err := fixture.Dial(p.Address, "/v1/control", url.Values{"publicKey": {encoded}})
		if c != nil {
			c.Close()
		}
		if err == nil || status != 400 {
			t.Fatal("noncanonical public key admitted")
		}
	}
	h.Control.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "restart"), time.Now().Add(time.Second))
	if got := closed(t, c, 1000); got.Text != "restart" {
		t.Fatal("close reason lost")
	}
	closed(t, a, 1000)
	next := host(t, p, key)
	nc, na := pairSockets(t, next)
	write(t, nc, 1, []byte("reconnected"))
	read(t, na, 1, []byte("reconnected"))
	if m := metrics(t, p); m["activeHosts"] != 1 || m["activePairs"] != 1 {
		t.Fatal(m)
	}
}

func TestOpaqueMessagesAndOrdering(t *testing.T) {
	p := start(t, nil)
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	binary := make([]byte, 65536)
	rand.Read(binary)
	payloads := []struct {
		kind int
		body []byte
	}{
		{1, []byte(`{"type":"hello","version":9}`)},
		{1, []byte(`{"type":"e2ee_hello","data":"opaque"}`)},
		{1, []byte("<inventory><item id=\"7\"/></inventory>")},
		{2, binary}, {1, []byte{}}, {2, []byte{}},
	}
	for _, direction := range [][2]*websocket.Conn{{c, a}, {a, c}} {
		for _, m := range payloads {
			write(t, direction[0], m.kind, m.body)
		}
		for _, m := range payloads {
			read(t, direction[1], m.kind, m.body)
		}
		for i := 0; i < 100; i++ {
			write(t, direction[0], 2, []byte(fmt.Sprintf("message-%d", i)))
		}
		for i := 0; i < 100; i++ {
			read(t, direction[1], 2, []byte(fmt.Sprintf("message-%d", i)))
		}
	}
	c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "finished"), time.Now().Add(time.Second))
	if ce := closed(t, a, 4001); ce.Text != "finished" {
		t.Fatal("close reason lost")
	}
	event(t, h, "closed")
	if m := metrics(t, p); m["activePairs"] != 0 || m["forwardedMessages"] != 212 {
		t.Fatal(m)
	}
}

func TestTokensAndGenerations(t *testing.T) {
	p := start(t, nil)
	h := host(t, p, nil)
	other := host(t, p, nil)
	c, err := h.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	incoming := event(t, h, "incoming")
	wrong := incoming
	wrong.Token = fixture.Encode(make([]byte, 32))
	for _, attempt := range []struct {
		h *fixture.Host
		r fixture.Record
	}{{h, wrong}, {other, incoming}, {h, fixture.Record{Type: "incoming", ConnectionID: incoming.ConnectionID}}} {
		a, status, err := attempt.h.Accept(attempt.r)
		if a != nil {
			a.Close()
		}
		if err == nil || status != 403 {
			t.Fatal("invalid token admitted")
		}
	}
	a, _, err := h.Accept(incoming)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	reused, status, err := h.Accept(incoming)
	if reused != nil {
		reused.Close()
	}
	if err == nil || status != 403 {
		t.Fatal("reused token admitted")
	}
	waiting, err := h.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer waiting.Close()
	stale := event(t, h, "incoming")
	h.Control.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "restart"), time.Now().Add(time.Second))
	closed(t, waiting, 1000)
	closed(t, c, 1000)
	fresh := host(t, p, h.Key)
	invalid, status, err := fresh.Accept(stale)
	if invalid != nil {
		invalid.Close()
	}
	if err == nil || status != 403 {
		t.Fatal("stale generation admitted")
	}
	nc, na := pairSockets(t, fresh)
	a.Close()
	c.Close()
	write(t, nc, 1, []byte("fresh"))
	read(t, na, 1, []byte("fresh"))
}

func TestMultipleHostsAndConcurrentClients(t *testing.T) {
	p := start(t, nil)
	hosts := []*fixture.Host{host(t, p, nil), host(t, p, nil), host(t, p, nil)}
	type endpoints struct {
		c, a    *websocket.Conn
		payload []byte
	}
	var pairs []endpoints
	for i := 0; i < 24; i++ {
		c, a := pairSockets(t, hosts[i%len(hosts)])
		pairs = append(pairs, endpoints{c, a, []byte(fmt.Sprintf("private-%d", i))})
	}
	var wg sync.WaitGroup
	failures := make(chan error, len(pairs))
	for _, p := range pairs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 20; i++ {
				if err := p.c.WriteMessage(2, p.payload); err != nil {
					failures <- err
					return
				}
				k, b, err := p.a.ReadMessage()
				if err != nil || k != 2 || !bytes.Equal(b, p.payload) {
					failures <- errors.New("cross-delivery or read failure")
					return
				}
				if err := p.a.WriteMessage(1, p.payload); err != nil {
					failures <- err
					return
				}
				k, b, err = p.c.ReadMessage()
				if err != nil || k != 1 || !bytes.Equal(b, p.payload) {
					failures <- errors.New("cross-delivery or read failure")
					return
				}
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
}

func TestPendingBufferAndTimeout(t *testing.T) {
	p := start(t, map[string]string{"RELAY_PAIR_TIMEOUT_MS": "300"})
	h := host(t, p, nil)
	c, err := h.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	incoming := event(t, h, "incoming")
	for i := 0; i < 12; i++ {
		write(t, c, 1, []byte(fmt.Sprint(i)))
	}
	a, _, err := h.Accept(incoming)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	for i := 0; i < 12; i++ {
		read(t, a, 1, []byte(fmt.Sprint(i)))
	}
	c.Close()
	event(t, h, "closed")
	waiting, err := h.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer waiting.Close()
	expired := event(t, h, "incoming")
	closed(t, waiting, 1013)
	event(t, h, "closed")
	accepted, status, err := h.Accept(expired)
	if accepted != nil {
		accepted.Close()
	}
	if err == nil || status != 403 {
		t.Fatal("expired token accepted")
	}
	if m := metrics(t, p); m["pendingPairs"] != 0 || m["activePairs"] != 0 {
		t.Fatal(m)
	}
}

func TestPendingQueueLimits(t *testing.T) {
	for _, kind := range []string{"bytes", "messages"} {
		t.Run(kind, func(t *testing.T) {
			env := map[string]string{"RELAY_MAX_QUEUE_BYTES": "16", "RELAY_MAX_QUEUE_MESSAGES": "2"}
			p := start(t, env)
			h := host(t, p, nil)
			c, err := h.Connect()
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			event(t, h, "incoming")
			if kind == "bytes" {
				write(t, c, 2, make([]byte, 17))
			} else {
				for i := 0; i < 3; i++ {
					write(t, c, 2, nil)
				}
			}
			closed(t, c, 1013)
			event(t, h, "closed")
			if m := metrics(t, p); m["pendingPairs"] != 0 {
				t.Fatal(m)
			}
		})
	}
}

func TestOversizeAndAbruptDisconnect(t *testing.T) {
	p := start(t, map[string]string{"RELAY_MAX_MESSAGE_BYTES": "64"})
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	write(t, c, 2, make([]byte, 65))
	closed(t, c, 1009)
	closed(t, a, 1009)
	event(t, h, "closed")
	c, a = pairSockets(t, h)
	write(t, a, 2, make([]byte, 65))
	closed(t, c, 1009)
	closed(t, a, 1009)
	event(t, h, "closed")
	c, a = pairSockets(t, h)
	c.UnderlyingConn().Close()
	closed(t, a, 1011)
	event(t, h, "closed")
	c, a = pairSockets(t, h)
	a.UnderlyingConn().Close()
	closed(t, c, 1011)
	event(t, h, "closed")
}

func TestAdmissionLimits(t *testing.T) {
	p := start(t, map[string]string{"RELAY_MAX_CLIENTS": "3", "RELAY_MAX_CLIENTS_PER_HOST": "2", "RELAY_MAX_PENDING_PER_HOST": "1"})
	h := host(t, p, nil)
	other := host(t, p, nil)
	c, err := h.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	incoming := event(t, h, "incoming")
	rejectConnect := func(h *fixture.Host, expected int) {
		t.Helper()
		c, status, err := fixture.Dial(p.Address, "/v1/connect", url.Values{"endpointId": {h.ID}})
		if c != nil {
			c.Close()
		}
		if err == nil || status != expected {
			t.Fatalf("admission status %d", status)
		}
	}
	rejectConnect(h, 503)
	a, _, err := h.Accept(incoming)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	c2, a2 := pairSockets(t, h)
	defer c2.Close()
	defer a2.Close()
	rejectConnect(h, 503)
	c3, a3 := pairSockets(t, other)
	defer c3.Close()
	defer a3.Close()
	rejectConnect(other, 503)
	absent := *h
	absent.ID = strings.Repeat("0", 64)
	rejectConnect(&absent, 404)
}

func TestRateLimitAndAuthenticationTimeout(t *testing.T) {
	t.Run("rate", func(t *testing.T) {
		p := start(t, map[string]string{"RELAY_ADMISSION_RATE": "1"})
		for i, expected := range []int{404, 429} {
			c, status, err := fixture.Dial(p.Address, "/v1/connect", url.Values{"endpointId": {strings.Repeat("0", 64)}})
			if c != nil {
				c.Close()
			}
			if err == nil || status != expected {
				t.Fatalf("attempt %d status %d", i, status)
			}
		}
	})
	t.Run("authentication", func(t *testing.T) {
		p := start(t, map[string]string{"RELAY_AUTH_TIMEOUT_MS": "80"})
		_, key, _ := ed25519.GenerateKey(rand.Reader)
		c, _ := authSocket(t, p, key)
		closed(t, c, 1008)
	})
}

func TestHeartbeatCleanup(t *testing.T) {
	p := start(t, map[string]string{"RELAY_HEARTBEAT_MS": "80"})
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	c.SetPingHandler(func(string) error { return nil })
	closed(t, c, 1011)
	closed(t, a, 1011)
	event(t, h, "closed")

	_, key, _ := ed25519.GenerateKey(rand.Reader)
	control, challenge := authSocket(t, p, key)
	signature := ed25519.Sign(key, []byte("passio-relay-v1\n"+fixture.Identity(key)+"\n"+challenge.Nonce))
	control.WriteJSON(map[string]string{"type": "authenticate", "signature": fixture.Encode(signature)})
	var registered fixture.Record
	if err := control.ReadJSON(&registered); err != nil {
		t.Fatal(err)
	}
	silent := &fixture.Host{Address: p.Address, ID: registered.EndpointID, Control: control}
	c, err := silent.Connect()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var incoming fixture.Record
	if err := control.ReadJSON(&incoming); err != nil {
		t.Fatal(err)
	}
	a, _, err = silent.Accept(incoming)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	closed(t, c, 1011)
	closed(t, a, 1011)
	if m := metrics(t, p); m["activeHosts"] != 1 {
		t.Fatal(m)
	}
}

func TestSlowReaderIsolation(t *testing.T) {
	p := start(t, map[string]string{"RELAY_MAX_QUEUE_BYTES": "65536", "RELAY_MAX_QUEUE_MESSAGES": "4", "RELAY_WRITE_TIMEOUT_MS": "100"})
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	if tcp, ok := a.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetReadBuffer(1024)
	}
	healthy := host(t, p, nil)
	hc, ha := pairSockets(t, healthy)
	go fixture.Echo(ha)
	ended := make(chan struct{})
	go func() {
		defer close(ended)
		c.SetWriteDeadline(time.Now().Add(6 * time.Second))
		for i := 0; i < 4096; i++ {
			if c.WriteMessage(2, make([]byte, 65536)) != nil {
				return
			}
		}
	}()
	for i := 0; i < 50; i++ {
		write(t, hc, 1, []byte("healthy"))
		read(t, hc, 1, []byte("healthy"))
	}
	closed(t, c, 1013, 1011)
	event(t, h, "closed")
	c.Close()
	select {
	case <-ended:
	case <-deadline(t).Done():
		t.Fatal("flood did not stop")
	}
}

func TestGracefulShutdown(t *testing.T) {
	for _, finish := range []bool{true, false} {
		t.Run(fmt.Sprint(finish), func(t *testing.T) {
			p := start(t, nil)
			h := host(t, p, nil)
			c, a := pairSockets(t, h)
			p.Cmd.Process.Signal(syscall.SIGTERM)
			select {
			case <-p.Draining:
			case <-deadline(t).Done():
				t.Fatal("no drain event")
			}
			response, err := http.Get("http://" + p.Address + "/healthz")
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != 503 {
				t.Fatal("health stayed ready")
			}
			n, status, err := fixture.Dial(p.Address, "/v1/connect", url.Values{"endpointId": {h.ID}})
			if n != nil {
				n.Close()
			}
			if err == nil || status != 503 {
				t.Fatal("admission during drain")
			}
			write(t, c, 1, []byte("during drain"))
			read(t, a, 1, []byte("during drain"))
			if finish {
				c.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "done"), time.Now().Add(time.Second))
				closed(t, a, 1000)
			} else {
				closed(t, c, 1001, 1006)
			}
			select {
			case <-p.Done:
			case <-time.After(6 * time.Second):
				t.Fatal("drain exceeded bound")
			}
		})
	}
}

func TestWriteDeadlineWithStalledReader(t *testing.T) {
	p := start(t, map[string]string{"RELAY_MAX_QUEUE_BYTES": "16777216", "RELAY_MAX_QUEUE_MESSAGES": "256", "RELAY_WRITE_TIMEOUT_MS": "80"})
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	if tcp, ok := a.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetReadBuffer(1024)
	}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		body := make([]byte, 65536)
		c.SetWriteDeadline(time.Now().Add(5 * time.Second))
		for i := 0; i < 128; i++ {
			if c.WriteMessage(2, body) != nil {
				return
			}
		}
	}()
	closed(t, c, 1011)
	event(t, h, "closed")
	c.Close()
	select {
	case <-finished:
	case <-deadline(t).Done():
		t.Fatal("stalled writer did not finish")
	}
}

func TestHostSlotsAndRepeatedAuthentication(t *testing.T) {
	p := start(t, map[string]string{"RELAY_MAX_CLIENTS": "1", "RELAY_AUTH_TIMEOUT_MS": "200"})
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	c, challenge := authSocket(t, p, key)
	second, status, err := fixture.Dial(p.Address, "/v1/control", url.Values{"publicKey": {fixture.Encode(key.Public().(ed25519.PublicKey))}})
	if second != nil {
		second.Close()
	}
	if err == nil || status != 503 {
		t.Fatal("authentication slots unbounded")
	}
	signed := ed25519.Sign(key, []byte("passio-relay-v1\n"+fixture.Identity(key)+"\n"+challenge.Nonce))
	auth := map[string]string{"type": "authenticate", "signature": fixture.Encode(signed)}
	c.WriteJSON(auth)
	var registered fixture.Record
	if err := c.ReadJSON(&registered); err != nil || registered.Type != "registered" {
		t.Fatal("registration failed")
	}
	c.WriteJSON(auth)
	closed(t, c, 1008)
	h := host(t, p, key)
	client, accepted := pairSockets(t, h)
	write(t, accepted, 2, []byte("available"))
	read(t, client, 2, []byte("available"))
}

func TestHealthAndCloseNotificationOnce(t *testing.T) {
	p := start(t, nil)
	response, err := http.Get("http://" + p.Address + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var state map[string]string
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil || response.StatusCode != 200 || state["status"] != "ok" {
		t.Fatal("health contract failed")
	}
	h := host(t, p, nil)
	c, a := pairSockets(t, h)
	c.Close()
	a.Close()
	event(t, h, "closed")
	next, accepted := pairSockets(t, h)
	write(t, next, 1, []byte("still live"))
	read(t, accepted, 1, []byte("still live"))
}
