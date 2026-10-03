package relay_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
	"passio-relay/internal/relay"
)

const deadline = 5 * time.Second

type testRelay struct {
	*relay.Relay
	WS   string
	HTTP string
}

func startRelay(t *testing.T, mutate func(*relay.Config)) *testRelay {
	t.Helper()
	cfg := relay.DefaultConfig()
	cfg.Heartbeat = 500 * time.Millisecond
	if mutate != nil {
		mutate(&cfg)
	}
	r := relay.New(cfg, nil)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: r.Handler()}
	go srv.Serve(ln)
	t.Cleanup(func() {
		r.CloseAll()
		srv.Close()
	})
	return &testRelay{Relay: r, WS: "ws://" + ln.Addr().String(), HTTP: "http://" + ln.Addr().String()}
}

func ctx(t *testing.T) context.Context {
	t.Helper()
	c, cancel := context.WithTimeout(context.Background(), deadline)
	t.Cleanup(cancel)
	return c
}

func mustRegister(t *testing.T, r *testRelay, id endpoint.Identity) *endpoint.Host {
	t.Helper()
	h, err := endpoint.Register(ctx(t), r.WS, id)
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	t.Cleanup(func() { h.Control.Close() })
	return h
}

func mustConnect(t *testing.T, r *testRelay, endpointID string) *websocket.Conn {
	t.Helper()
	c, _, err := endpoint.Connect(ctx(t), r.WS, endpointID)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func mustPair(t *testing.T, r *testRelay, h *endpoint.Host) (client, hostData *websocket.Conn, connectionID string) {
	t.Helper()
	client = mustConnect(t, r, h.Identity.EndpointID)
	msg, err := h.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatalf("incoming: %v", err)
	}
	hostData, _, err = h.Accept(ctx(t), msg.ConnectionID, msg.Token)
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	t.Cleanup(func() { hostData.Close() })
	return client, hostData, msg.ConnectionID
}

func expectMessage(t *testing.T, c *websocket.Conn, wantType int, want []byte) {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(deadline))
	mt, data, err := c.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt != wantType || string(data) != string(want) {
		t.Fatalf("got type %d %q, want type %d %q", mt, truncate(data), wantType, truncate(want))
	}
}

func truncate(b []byte) []byte {
	if len(b) > 64 {
		return b[:64]
	}
	return b
}

func expectClose(t *testing.T, c *websocket.Conn, wantCode int) string {
	t.Helper()
	return expectCloseWithin(t, c, wantCode, deadline)
}

func expectCloseWithin(t *testing.T, c *websocket.Conn, wantCode int, timeout time.Duration) string {
	t.Helper()
	code, reason, err := endpoint.ReadClose(c, timeout)
	if err != nil {
		t.Fatalf("expected close %d, got error %v", wantCode, err)
	}
	if code != wantCode {
		t.Fatalf("close code %d %q, want %d", code, reason, wantCode)
	}
	return reason
}

func expectAbnormalClose(t *testing.T, c *websocket.Conn) {
	t.Helper()
	_, _, err := endpoint.ReadClose(c, deadline)
	var ce *websocket.CloseError
	if err == nil || errors.As(err, &ce) {
		t.Fatalf("expected abnormal close, got %v", err)
	}
}

func expectClosedEvent(t *testing.T, h *endpoint.Host, connectionID string) {
	t.Helper()
	if _, err := h.WaitEvent(ctx(t), "closed", connectionID); err != nil {
		t.Fatalf("closed event for %s: %v", connectionID, err)
	}
}

func dialStatus(t *testing.T, url string) (*websocket.Conn, int) {
	t.Helper()
	c, resp, err := endpoint.Dialer.DialContext(ctx(t), url, nil)
	if err != nil {
		if resp == nil {
			t.Fatalf("dial %s: %v", url, err)
		}
		return nil, resp.StatusCode
	}
	t.Cleanup(func() { c.Close() })
	return c, resp.StatusCode
}

func getJSON(t *testing.T, url string, into any) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if into != nil {
		if err := json.NewDecoder(resp.Body).Decode(into); err != nil {
			t.Fatal(err)
		}
	}
	return resp.StatusCode
}

func metrics(t *testing.T, r *testRelay) relay.MetricsSnapshot {
	t.Helper()
	var m relay.MetricsSnapshot
	getJSON(t, r.HTTP+"/metrics", &m)
	return m
}

func waitMetrics(t *testing.T, r *testRelay, pred func(relay.MetricsSnapshot) bool) relay.MetricsSnapshot {
	t.Helper()
	stop := time.Now().Add(deadline)
	for {
		m := metrics(t, r)
		if pred(m) {
			return m
		}
		if time.Now().After(stop) {
			t.Fatalf("metrics never satisfied predicate: %+v", m)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
