package relay_test

import (
	"bytes"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
	"passio-relay/internal/relay"
)

func TestPendingBufferDrainsInOrder(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client := mustConnect(t, r, h.Identity.EndpointID)
	for i := 0; i < 20; i++ {
		if err := client.WriteMessage(websocket.TextMessage, []byte(fmt.Sprintf("pending-%d", i))); err != nil {
			t.Fatal(err)
		}
	}
	msg, err := h.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	if m := metrics(t, r); m.PendingPairs != 1 || m.ForwardedMessages != 0 {
		t.Fatalf("metrics before accept %+v", m)
	}
	hostData, _, err := h.Accept(ctx(t), msg.ConnectionID, msg.Token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hostData.Close() })
	for i := 0; i < 20; i++ {
		expectMessage(t, hostData, websocket.TextMessage, []byte(fmt.Sprintf("pending-%d", i)))
	}
	if err := client.WriteMessage(websocket.TextMessage, []byte("live")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.TextMessage, []byte("live"))
}

func TestPendingBufferLimits(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.MaxQueueMessages = 4 })
	h := mustRegister(t, r, endpoint.NewIdentity())
	client := mustConnect(t, r, h.Identity.EndpointID)
	msg, err := h.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := client.WriteMessage(websocket.TextMessage, []byte("m")); err != nil {
			t.Fatal(err)
		}
	}
	expectClose(t, client, websocket.CloseTryAgainLater)
	expectClosedEvent(t, h, msg.ConnectionID)
	if _, status := dialStatus(t, endpoint.AcceptURL(r.WS, h.Identity.EndpointID, msg.ConnectionID, msg.Token)); status != http.StatusNotFound {
		t.Fatalf("accept after limit close: %d", status)
	}

	r2 := startRelay(t, func(c *relay.Config) { c.MaxMessageBytes = 1000; c.MaxQueueBytes = 2500 })
	h2 := mustRegister(t, r2, endpoint.NewIdentity())
	client2 := mustConnect(t, r2, h2.Identity.EndpointID)
	msg2, err := h2.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := client2.WriteMessage(websocket.BinaryMessage, make([]byte, 1000)); err != nil {
			t.Fatal(err)
		}
	}
	expectClose(t, client2, websocket.CloseTryAgainLater)
	expectClosedEvent(t, h2, msg2.ConnectionID)
}

func TestPairTimeout(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.PairTimeout = 150 * time.Millisecond })
	h := mustRegister(t, r, endpoint.NewIdentity())
	client := mustConnect(t, r, h.Identity.EndpointID)
	msg, err := h.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	expectClose(t, client, websocket.CloseTryAgainLater)
	expectClosedEvent(t, h, msg.ConnectionID)
	if _, status := dialStatus(t, endpoint.AcceptURL(r.WS, h.Identity.EndpointID, msg.ConnectionID, msg.Token)); status != http.StatusNotFound {
		t.Fatalf("expired token: status %d, want 404", status)
	}
	if m := metrics(t, r); m.PendingPairs != 0 || m.ActivePairs != 0 {
		t.Fatalf("metrics %+v", m)
	}
	client2, hostData2, _ := mustPair(t, r, h)
	if err := client2.WriteMessage(websocket.TextMessage, []byte("after")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData2, websocket.TextMessage, []byte("after"))
}

func TestOversizeMessage(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.MaxMessageBytes = 4096 })
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, connectionID := mustPair(t, r, h)
	if err := client.WriteMessage(websocket.BinaryMessage, make([]byte, 4096)); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.BinaryMessage, make([]byte, 4096))
	if err := hostData.WriteMessage(websocket.BinaryMessage, make([]byte, 4097)); err != nil {
		t.Fatal(err)
	}
	expectClose(t, hostData, websocket.CloseMessageTooBig)
	expectClose(t, client, websocket.CloseMessageTooBig)
	expectClosedEvent(t, h, connectionID)
}

func TestSlowReaderIsolation(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) {
		c.MaxQueueBytes = 256 << 10
		c.MaxQueueMessages = 64
		c.WriteTimeout = 300 * time.Millisecond
	})
	h := mustRegister(t, r, endpoint.NewIdentity())
	stalledClient, stalledHost, stalledID := mustPair(t, r, h)
	healthyClient, healthyHost, _ := mustPair(t, r, h)
	_ = stalledHost

	flood := make(chan struct{})
	go func() {
		defer close(flood)
		chunk := make([]byte, 64<<10)
		for i := 0; i < 2000; i++ {
			stalledClient.SetWriteDeadline(time.Now().Add(deadline))
			if err := stalledClient.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				return
			}
		}
	}()
	for i := 0; i < 50; i++ {
		body := []byte(fmt.Sprintf("healthy-%d", i))
		if err := healthyClient.WriteMessage(websocket.TextMessage, body); err != nil {
			t.Fatal(err)
		}
		expectMessage(t, healthyHost, websocket.TextMessage, body)
		if err := healthyHost.WriteMessage(websocket.TextMessage, body); err != nil {
			t.Fatal(err)
		}
		expectMessage(t, healthyClient, websocket.TextMessage, body)
	}
	expectClosedEvent(t, h, stalledID)
	<-flood
	reason := expectClose(t, stalledHost, websocket.CloseTryAgainLater)
	t.Logf("stalled pair closed: %s", reason)
	m := waitMetrics(t, r, func(m relay.MetricsSnapshot) bool { return m.ActivePairs == 1 })
	if m.PendingPairs != 0 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestConnectionLimits(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) {
		c.MaxClients = 3
		c.MaxClientsPerHost = 2
		c.MaxPendingPerHost = 1
	})
	hostA := mustRegister(t, r, endpoint.NewIdentity())
	hostB := mustRegister(t, r, endpoint.NewIdentity())

	mustConnect(t, r, hostA.Identity.EndpointID)
	if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, hostA.Identity.EndpointID)); status != http.StatusServiceUnavailable {
		t.Fatalf("pending limit: status %d", status)
	}
	msg, err := hostA.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	hostDataA, _, err := hostA.Accept(ctx(t), msg.ConnectionID, msg.Token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hostDataA.Close() })
	mustPair(t, r, hostA)
	if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, hostA.Identity.EndpointID)); status != http.StatusServiceUnavailable {
		t.Fatalf("per-host limit: status %d", status)
	}
	mustPair(t, r, hostB)
	if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, hostB.Identity.EndpointID)); status != http.StatusServiceUnavailable {
		t.Fatalf("global limit: status %d", status)
	}
	if m := metrics(t, r); m.ActivePairs != 3 || m.RejectedConnections != 3 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestAdmissionRateLimit(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.AdmissionRate = 2 })
	h := mustRegister(t, r, endpoint.NewIdentity())
	var limited int
	for i := 0; i < 10; i++ {
		if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, h.Identity.EndpointID)); status == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("expected some connections to be rate limited")
	}
	if code := getJSON(t, r.HTTP+"/healthz", nil); code != 200 {
		t.Fatalf("healthz %d", code)
	}
}

func TestCloseCodePropagation(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())

	client, hostData, id := mustPair(t, r, h)
	endpoint.CloseWith(client, 4001, "custom reason")
	if reason := expectClose(t, hostData, 4001); reason != "custom reason" {
		t.Fatalf("reason %q", reason)
	}
	expectClose(t, client, 4001)
	expectClosedEvent(t, h, id)

	client, hostData, id = mustPair(t, r, h)
	endpoint.CloseWith(hostData, websocket.CloseNormalClosure, "")
	expectClose(t, client, websocket.CloseNormalClosure)
	expectClosedEvent(t, h, id)

	client, hostData, id = mustPair(t, r, h)
	client.NetConn().(*net.TCPConn).SetLinger(0)
	client.NetConn().Close()
	expectClose(t, hostData, websocket.CloseInternalServerErr)
	expectClosedEvent(t, h, id)

	m := waitMetrics(t, r, func(m relay.MetricsSnapshot) bool { return m.ActivePairs == 0 })
	if m.PendingPairs != 0 || m.ActiveHosts != 1 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestClosedNotificationOnce(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, id := mustPair(t, r, h)
	endpoint.CloseWith(client, websocket.CloseNormalClosure, "")
	endpoint.CloseWith(hostData, websocket.CloseNormalClosure, "")
	expectClosedEvent(t, h, id)
	_, probeHost, probeID := mustPair(t, r, h)
	endpoint.CloseWith(probeHost, websocket.CloseNormalClosure, "")
	msg, err := h.WaitEvent(ctx(t), "closed", "")
	if err != nil {
		t.Fatal(err)
	}
	if msg.ConnectionID != probeID {
		t.Fatalf("duplicate closed notification for %s", msg.ConnectionID)
	}
}

func TestHeartbeatCleanup(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.Heartbeat = 100 * time.Millisecond })
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, id := mustPair(t, r, h)
	client.SetPingHandler(func(string) error { return nil })
	go func() {
		for {
			if _, _, err := client.ReadMessage(); err != nil {
				return
			}
		}
	}()
	start := time.Now()
	expectClose(t, hostData, websocket.CloseInternalServerErr)
	expectClosedEvent(t, h, id)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("heartbeat cleanup took %s", elapsed)
	}
}

func TestHostControlCloseTearsDownPairs(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	activeClient, activeHost, _ := mustPair(t, r, h)
	pendingClient := mustConnect(t, r, h.Identity.EndpointID)
	if _, err := h.WaitEvent(ctx(t), "incoming", ""); err != nil {
		t.Fatal(err)
	}
	h.Control.NetConn().Close()
	expectClose(t, activeClient, websocket.CloseGoingAway)
	expectClose(t, activeHost, websocket.CloseGoingAway)
	expectClose(t, pendingClient, websocket.CloseGoingAway)
	m := waitMetrics(t, r, func(m relay.MetricsSnapshot) bool { return m.ActiveHosts == 0 })
	if m.ActivePairs != 0 || m.PendingPairs != 0 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestLargeMessageRoundTrip(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)
	big := bytes.Repeat([]byte("abcdefgh"), (1<<20)/8)
	if err := client.WriteMessage(websocket.BinaryMessage, big); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.BinaryMessage, big)
}

func TestStalledReaderWriteTimeout(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) {
		c.MaxQueueBytes = 64 << 20
		c.MaxQueueMessages = 4096
		c.WriteTimeout = 300 * time.Millisecond
	})
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, id := mustPair(t, r, h)
	chunk := make([]byte, 64<<10)
	go func() {
		for i := 0; i < 400; i++ {
			client.SetWriteDeadline(time.Now().Add(deadline))
			if err := client.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()
	expectClosedEvent(t, h, id)
	reason := expectClose(t, client, websocket.CloseTryAgainLater)
	if reason != "slow consumer" {
		t.Fatalf("reason %q", reason)
	}
	if code, _, err := endpoint.ReadClose(hostData, deadline); err == nil && code != websocket.CloseTryAgainLater && code != websocket.CloseAbnormalClosure {
		t.Fatalf("stalled host socket closed with %d", code)
	}
}

func TestTinyMessageLimitKeepsControlWorking(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.MaxMessageBytes = 1 })
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, id := mustPair(t, r, h)
	if err := client.WriteMessage(websocket.BinaryMessage, []byte{7}); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.BinaryMessage, []byte{7})
	if err := client.WriteMessage(websocket.BinaryMessage, []byte{1, 2}); err != nil {
		t.Fatal(err)
	}
	expectClose(t, hostData, websocket.CloseMessageTooBig)
	expectClosedEvent(t, h, id)
	if m := metrics(t, r); m.ActiveHosts != 1 {
		t.Fatalf("metrics %+v", m)
	}
}
