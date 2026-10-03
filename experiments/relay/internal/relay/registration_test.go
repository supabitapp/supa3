package relay_test

import (
	"encoding/base64"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
	"passio-relay/internal/relay"
)

func TestHealthAndMetrics(t *testing.T) {
	r := startRelay(t, nil)
	var health struct{ Status string }
	if code := getJSON(t, r.HTTP+"/healthz", &health); code != 200 || health.Status != "ok" {
		t.Fatalf("healthz %d %+v", code, health)
	}
	m := metrics(t, r)
	if m.ActiveHosts != 0 || m.ActivePairs != 0 {
		t.Fatalf("unexpected metrics %+v", m)
	}
}

func TestHostRegistration(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	h := mustRegister(t, r, id)
	if m := metrics(t, r); m.ActiveHosts != 1 {
		t.Fatalf("activeHosts %d", m.ActiveHosts)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if m := metrics(t, r); m.ActiveHosts != 0 {
		t.Fatalf("activeHosts after close %d", m.ActiveHosts)
	}
	if _, _, err := endpoint.Connect(ctx(t), r.WS, id.EndpointID); err == nil {
		t.Fatal("connect to unregistered endpoint should fail")
	}
}

func TestInvalidSignature(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	other := endpoint.NewIdentity()
	conn, challenge, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := endpoint.Authenticate(conn, endpoint.Sign(other, challenge.Nonce)); err == nil {
		t.Fatal("expected rejection")
	} else if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expected 1008, got %v", err)
	}

	conn, _, err = endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := endpoint.Authenticate(conn, ""); err == nil {
		t.Fatal("expected rejection for missing signature")
	}

	conn, challenge, err = endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	padded := endpoint.Sign(id, challenge.Nonce) + "="
	if _, err := endpoint.Authenticate(conn, padded); err == nil {
		t.Fatal("expected rejection for padded signature")
	}
	if m := metrics(t, r); m.ActiveHosts != 0 || m.RejectedConnections < 3 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestNoncanonicalPublicKeyRejectedBeforeUpgrade(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	for _, bad := range []string{
		"",
		id.PublicKeyParam() + "=",
		base64.URLEncoding.EncodeToString(id.Public),
		base64.RawURLEncoding.EncodeToString(id.Public[:31]),
		id.PublicKeyParam()[:42] + "B",
	} {
		if _, status := dialStatus(t, endpoint.ControlURL(r.WS, bad)); status != http.StatusBadRequest {
			t.Fatalf("publicKey %q: status %d, want 400", bad, status)
		}
	}
	if _, status := dialStatus(t, endpoint.ControlURL(r.WS, id.PublicKeyParam())); status != http.StatusSwitchingProtocols {
		t.Fatalf("canonical key: status %d", status)
	}
}

func TestStolenEndpointClaim(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	h := mustRegister(t, r, id)
	conn, challenge, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = endpoint.Authenticate(conn, endpoint.Sign(id, challenge.Nonce))
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expected 1008 for duplicate registration, got %v", err)
	}
	client, hostData, _ := mustPair(t, r, h)
	if err := client.WriteMessage(websocket.TextMessage, []byte("still alive")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.TextMessage, []byte("still alive"))
	if m := metrics(t, r); m.ActiveHosts != 1 {
		t.Fatalf("activeHosts %d", m.ActiveHosts)
	}
}

func TestChallengeReplay(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	first, challenge, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	signature := endpoint.Sign(id, challenge.Nonce)
	reply, err := endpoint.Authenticate(first, signature)
	if err != nil || reply.Type != "registered" {
		t.Fatalf("first registration: %v %+v", err, reply)
	}
	if err := first.WriteJSON(endpoint.ControlMessage{Type: "authenticate", Signature: signature}); err != nil {
		t.Fatal(err)
	}
	expectClose(t, first, websocket.ClosePolicyViolation)

	second, _, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	_, err = endpoint.Authenticate(second, signature)
	if ce, ok := err.(*websocket.CloseError); !ok || ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expected 1008 for replayed signature, got %v", err)
	}
}

func TestAuthenticationTimeout(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.AuthTimeout = 100 * time.Millisecond })
	id := endpoint.NewIdentity()
	conn, _, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	expectClose(t, conn, websocket.ClosePolicyViolation)
}

func TestLegitimateReconnect(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	h := mustRegister(t, r, id)
	client, _, connectionID := mustPair(t, r, h)
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	expectClose(t, client, websocket.CloseGoingAway)
	h2 := mustRegister(t, r, id)
	if _, _, err := h2.Accept(ctx(t), connectionID, "x"); err == nil {
		t.Fatal("stale pair should not be acceptable")
	}
	client2, hostData2, _ := mustPair(t, r, h2)
	if err := hostData2.WriteMessage(websocket.BinaryMessage, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, client2, websocket.BinaryMessage, []byte{1, 2, 3})
}

func TestControlSocketCap(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) { c.MaxHosts = 2 })
	h := mustRegister(t, r, endpoint.NewIdentity())
	unauthenticated, _, err := endpoint.OpenControl(ctx(t), r.WS, endpoint.NewIdentity())
	if err != nil {
		t.Fatal(err)
	}
	third := endpoint.NewIdentity()
	if _, status := dialStatus(t, endpoint.ControlURL(r.WS, third.PublicKeyParam())); status != http.StatusServiceUnavailable {
		t.Fatalf("over cap: status %d, want 503", status)
	}
	if m := metrics(t, r); m.ControlSockets != 2 || m.ActiveHosts != 1 || m.RejectedConnections != 1 {
		t.Fatalf("metrics %+v", m)
	}
	endpoint.CloseWith(unauthenticated, websocket.CloseNormalClosure, "")
	expectClose(t, unauthenticated, websocket.ClosePolicyViolation)
	h3 := mustRegister(t, r, third)
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	if m := metrics(t, r); m.ControlSockets != 1 || m.ActiveHosts != 1 {
		t.Fatalf("metrics after release %+v", m)
	}
	h4 := mustRegister(t, r, endpoint.NewIdentity())
	if _, status := dialStatus(t, endpoint.ControlURL(r.WS, endpoint.NewIdentity().PublicKeyParam())); status != http.StatusServiceUnavailable {
		t.Fatalf("over cap again: status %d, want 503", status)
	}
	h3.Close()
	h4.Close()
	if m := metrics(t, r); m.ControlSockets != 0 {
		t.Fatalf("metrics after all closed %+v", m)
	}
}

func TestUnsolicitedPongsDoNotExtendChallenge(t *testing.T) {
	r := startRelay(t, func(c *relay.Config) {
		c.AuthTimeout = 200 * time.Millisecond
		c.Heartbeat = 2 * time.Second
	})
	id := endpoint.NewIdentity()
	conn, challenge, err := endpoint.OpenControl(ctx(t), r.WS, id)
	if err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				conn.WriteControl(websocket.PongMessage, nil, time.Now().Add(time.Second))
			}
		}
	}()
	time.Sleep(600 * time.Millisecond)
	close(stop)
	reply, err := endpoint.Authenticate(conn, endpoint.Sign(id, challenge.Nonce))
	if err == nil || reply.Type == "registered" {
		t.Fatalf("late signature accepted: %+v", reply)
	}
	if ce, ok := err.(*websocket.CloseError); ok && ce.Code != websocket.ClosePolicyViolation {
		t.Fatalf("expected 1008 after challenge expiry, got %v", err)
	}
	if m := metrics(t, r); m.ActiveHosts != 0 || m.ControlSockets != 0 {
		t.Fatalf("metrics %+v", m)
	}
	mustRegister(t, r, id)
}
