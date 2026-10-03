package relay_test

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
	"passio-relay/internal/relay"
)

func TestBidirectionalForwarding(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)

	random := make([]byte, 70000)
	rand.Read(random)
	payloads := []struct {
		mt   int
		data []byte
	}{
		{websocket.TextMessage, []byte("hello from client")},
		{websocket.BinaryMessage, []byte{0, 255, 1, 254, 0}},
		{websocket.TextMessage, []byte{}},
		{websocket.BinaryMessage, []byte{}},
		{websocket.BinaryMessage, random},
		{websocket.TextMessage, []byte(`{"type":"hello","version":1,"token":"not-for-the-relay"}`)},
		{websocket.TextMessage, []byte(`{"type":"e2ee_hello","publicKey":"AAAA","nonce":"BBBB"}`)},
		{websocket.TextMessage, []byte(`{"type":"challenge","nonce":"fake"}`)},
		{websocket.TextMessage, []byte(`{"type":"incoming","connectionId":"x","token":"y"}`)},
		{websocket.TextMessage, []byte("ünïcödé ✓ 🎉")},
	}
	for _, p := range payloads {
		if err := client.WriteMessage(p.mt, p.data); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range payloads {
		expectMessage(t, hostData, p.mt, p.data)
	}
	for i := len(payloads) - 1; i >= 0; i-- {
		if err := hostData.WriteMessage(payloads[i].mt, payloads[i].data); err != nil {
			t.Fatal(err)
		}
	}
	for i := len(payloads) - 1; i >= 0; i-- {
		expectMessage(t, client, payloads[i].mt, payloads[i].data)
	}
	m := metrics(t, r)
	if m.ForwardedMessages != int64(2*len(payloads)) || m.ActivePairs != 1 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestMessageBoundariesAndOrder(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)
	const count = 500
	done := make(chan error, 1)
	go func() {
		for i := 0; i < count; i++ {
			size := (i * 7919) % 3000
			buf := make([]byte, size)
			for j := range buf {
				buf[j] = byte(i)
			}
			mt := websocket.BinaryMessage
			if i%3 == 0 {
				mt = websocket.TextMessage
				buf = []byte(fmt.Sprintf("%d:%s", i, bytes.Repeat([]byte("x"), size%100)))
			}
			if err := client.WriteMessage(mt, buf); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	for i := 0; i < count; i++ {
		hostData.SetReadDeadline(time.Now().Add(deadline))
		mt, data, err := hostData.ReadMessage()
		if err != nil {
			t.Fatal(err)
		}
		size := (i * 7919) % 3000
		if i%3 == 0 {
			want := fmt.Sprintf("%d:%s", i, bytes.Repeat([]byte("x"), size%100))
			if mt != websocket.TextMessage || string(data) != want {
				t.Fatalf("message %d: got type %d %q", i, mt, truncate(data))
			}
			continue
		}
		if mt != websocket.BinaryMessage || len(data) != size {
			t.Fatalf("message %d: got type %d len %d, want binary len %d", i, mt, len(data), size)
		}
		for _, b := range data {
			if b != byte(i) {
				t.Fatalf("message %d: corrupted content", i)
			}
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestUnrelatedPayloadFormats(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	client, hostData, _ := mustPair(t, r, h)

	rpc, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "sum", "params": []int{1, 2, 3}})
	if err := client.WriteMessage(websocket.TextMessage, rpc); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.TextMessage, rpc)
	rpcReply, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 7, "result": 6})
	if err := hostData.WriteMessage(websocket.TextMessage, rpcReply); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, client, websocket.TextMessage, rpcReply)

	frame := func(kind byte, body []byte) []byte {
		out := []byte{kind, byte(len(body) >> 8), byte(len(body))}
		return append(out, body...)
	}
	body := make([]byte, 1500)
	rand.Read(body)
	req := frame(0x01, body)
	if err := client.WriteMessage(websocket.BinaryMessage, req); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.BinaryMessage, req)
	resp := frame(0x02, []byte{0xde, 0xad, 0xbe, 0xef})
	if err := hostData.WriteMessage(websocket.BinaryMessage, resp); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, client, websocket.BinaryMessage, resp)
}

func TestMultipleHostsNoCrossDelivery(t *testing.T) {
	r := startRelay(t, nil)
	type pairing struct {
		client, hostData *websocket.Conn
		tag              string
	}
	var pairs []pairing
	for hi := 0; hi < 3; hi++ {
		h := mustRegister(t, r, endpoint.NewIdentity())
		clients := make([]*websocket.Conn, 4)
		for ci := range clients {
			clients[ci] = mustConnect(t, r, h.Identity.EndpointID)
		}
		for ci := range clients {
			tag := fmt.Sprintf("host%d-client%d", hi, ci)
			if err := clients[ci].WriteMessage(websocket.TextMessage, []byte(tag)); err != nil {
				t.Fatal(err)
			}
		}
		for range clients {
			msg, err := h.WaitEvent(ctx(t), "incoming", "")
			if err != nil {
				t.Fatal(err)
			}
			hostData, _, err := h.Accept(ctx(t), msg.ConnectionID, msg.Token)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { hostData.Close() })
			hostData.SetReadDeadline(time.Now().Add(deadline))
			_, tag, err := hostData.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			var client *websocket.Conn
			for ci := range clients {
				if string(tag) == fmt.Sprintf("host%d-client%d", hi, ci) {
					client = clients[ci]
				}
			}
			if client == nil {
				t.Fatalf("unknown tag %q", tag)
			}
			pairs = append(pairs, pairing{client: client, hostData: hostData, tag: string(tag)})
		}
	}
	for _, p := range pairs {
		if err := p.hostData.WriteMessage(websocket.TextMessage, []byte("reply:"+p.tag)); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range pairs {
		expectMessage(t, p.client, websocket.TextMessage, []byte("reply:"+p.tag))
	}
	if m := metrics(t, r); m.ActiveHosts != 3 || m.ActivePairs != 12 || m.PendingPairs != 0 {
		t.Fatalf("metrics %+v", m)
	}
}

func TestDataTokens(t *testing.T) {
	r := startRelay(t, nil)
	hostA := mustRegister(t, r, endpoint.NewIdentity())
	hostB := mustRegister(t, r, endpoint.NewIdentity())
	client := mustConnect(t, r, hostA.Identity.EndpointID)
	msg, err := hostA.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	wrongToken := endpoint.NewIdentity().PublicKeyParam()
	cases := map[string]struct {
		url  string
		want int
	}{
		"wrong token":        {endpoint.AcceptURL(r.WS, hostA.Identity.EndpointID, msg.ConnectionID, wrongToken), http.StatusForbidden},
		"missing token":      {endpoint.AcceptURL(r.WS, hostA.Identity.EndpointID, msg.ConnectionID, ""), http.StatusForbidden},
		"padded token":       {endpoint.AcceptURL(r.WS, hostA.Identity.EndpointID, msg.ConnectionID, msg.Token+"="), http.StatusForbidden},
		"other host":         {endpoint.AcceptURL(r.WS, hostB.Identity.EndpointID, msg.ConnectionID, msg.Token), http.StatusNotFound},
		"unknown endpoint":   {endpoint.AcceptURL(r.WS, "deadbeef", msg.ConnectionID, msg.Token), http.StatusNotFound},
		"unknown connection": {endpoint.AcceptURL(r.WS, hostA.Identity.EndpointID, "nope", msg.Token), http.StatusNotFound},
	}
	for name, c := range cases {
		if _, status := dialStatus(t, c.url); status != c.want {
			t.Fatalf("%s: status %d, want %d", name, status, c.want)
		}
	}
	hostData, _, err := hostA.Accept(ctx(t), msg.ConnectionID, msg.Token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { hostData.Close() })
	if _, status := dialStatus(t, endpoint.AcceptURL(r.WS, hostA.Identity.EndpointID, msg.ConnectionID, msg.Token)); status != http.StatusForbidden {
		t.Fatalf("reused token: status %d, want 403", status)
	}
	if err := client.WriteMessage(websocket.TextMessage, []byte("ok")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData, websocket.TextMessage, []byte("ok"))
}

func TestStaleGenerationToken(t *testing.T) {
	r := startRelay(t, nil)
	id := endpoint.NewIdentity()
	h := mustRegister(t, r, id)
	client := mustConnect(t, r, id.EndpointID)
	msg, err := h.WaitEvent(ctx(t), "incoming", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}
	expectClose(t, client, websocket.CloseGoingAway)
	h2 := mustRegister(t, r, id)
	if _, status := dialStatus(t, endpoint.AcceptURL(r.WS, id.EndpointID, msg.ConnectionID, msg.Token)); status != http.StatusNotFound {
		t.Fatalf("stale generation token: status %d, want 404", status)
	}
	m := metrics(t, r)
	if m.PendingPairs != 0 || m.ActivePairs != 0 || m.ActiveHosts != 1 {
		t.Fatalf("metrics %+v", m)
	}
	client2, hostData2, _ := mustPair(t, r, h2)
	if err := client2.WriteMessage(websocket.TextMessage, []byte("fresh")); err != nil {
		t.Fatal(err)
	}
	expectMessage(t, hostData2, websocket.TextMessage, []byte("fresh"))
}

func TestClientWithoutHostRejectedBeforeUpgrade(t *testing.T) {
	r := startRelay(t, nil)
	if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, endpoint.NewIdentity().EndpointID)); status != http.StatusNotFound {
		t.Fatalf("status %d, want 404", status)
	}
	if _, status := dialStatus(t, endpoint.ConnectURL(r.WS, "")); status != http.StatusNotFound {
		t.Fatalf("status %d, want 404", status)
	}
}

var _ = relay.DefaultConfig
