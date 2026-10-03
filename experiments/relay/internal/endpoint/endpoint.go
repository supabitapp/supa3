package endpoint

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/relay"
)

type Identity struct {
	Public     ed25519.PublicKey
	Private    ed25519.PrivateKey
	EndpointID string
}

func NewIdentity() Identity {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	return Identity{Public: pub, Private: priv, EndpointID: relay.EndpointID(pub)}
}

func (id Identity) PublicKeyParam() string {
	return base64.RawURLEncoding.EncodeToString(id.Public)
}

type ControlMessage struct {
	Type         string `json:"type"`
	Nonce        string `json:"nonce,omitempty"`
	Signature    string `json:"signature,omitempty"`
	EndpointID   string `json:"endpointId,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Token        string `json:"token,omitempty"`
}

var Dialer = &websocket.Dialer{HandshakeTimeout: 10 * time.Second}

func ControlURL(base, publicKeyParam string) string {
	return base + "/v1/control?publicKey=" + url.QueryEscape(publicKeyParam)
}

func ConnectURL(base, endpointID string) string {
	return base + "/v1/connect?endpointId=" + url.QueryEscape(endpointID)
}

func AcceptURL(base, endpointID, connectionID, token string) string {
	return base + "/v1/accept?endpointId=" + url.QueryEscape(endpointID) + "&connectionId=" + url.QueryEscape(connectionID) + "&token=" + url.QueryEscape(token)
}

type Host struct {
	Base       string
	Identity   Identity
	Control    *websocket.Conn
	Events     chan ControlMessage
	ReadErr    chan error
	readOnce   sync.Once
	closedOnce sync.Once
}

func OpenControl(ctx context.Context, base string, id Identity) (*websocket.Conn, ControlMessage, error) {
	conn, _, err := Dialer.DialContext(ctx, ControlURL(base, id.PublicKeyParam()), nil)
	if err != nil {
		return nil, ControlMessage{}, err
	}
	var challenge ControlMessage
	if err := conn.ReadJSON(&challenge); err != nil {
		conn.Close()
		return nil, ControlMessage{}, err
	}
	if challenge.Type != "challenge" {
		conn.Close()
		return nil, ControlMessage{}, fmt.Errorf("expected challenge, got %q", challenge.Type)
	}
	return conn, challenge, nil
}

func Sign(id Identity, nonce string) string {
	sig := ed25519.Sign(id.Private, relay.SignedBytes(id.EndpointID, nonce))
	return base64.RawURLEncoding.EncodeToString(sig)
}

func Authenticate(conn *websocket.Conn, signature string) (ControlMessage, error) {
	if err := conn.WriteJSON(ControlMessage{Type: "authenticate", Signature: signature}); err != nil {
		return ControlMessage{}, err
	}
	var reply ControlMessage
	if err := conn.ReadJSON(&reply); err != nil {
		return ControlMessage{}, err
	}
	return reply, nil
}

func Register(ctx context.Context, base string, id Identity) (*Host, error) {
	conn, challenge, err := OpenControl(ctx, base, id)
	if err != nil {
		return nil, err
	}
	reply, err := Authenticate(conn, Sign(id, challenge.Nonce))
	if err != nil {
		conn.Close()
		return nil, err
	}
	if reply.Type != "registered" || reply.EndpointID != id.EndpointID {
		conn.Close()
		return nil, fmt.Errorf("unexpected registration reply %+v", reply)
	}
	h := &Host{Base: base, Identity: id, Control: conn, Events: make(chan ControlMessage, 1024), ReadErr: make(chan error, 1)}
	go h.readLoop()
	return h, nil
}

func (h *Host) readLoop() {
	for {
		_, data, err := h.Control.ReadMessage()
		if err != nil {
			h.ReadErr <- err
			close(h.Events)
			return
		}
		var msg ControlMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		h.Events <- msg
	}
}

func (h *Host) NextEvent(ctx context.Context) (ControlMessage, error) {
	select {
	case <-ctx.Done():
		return ControlMessage{}, ctx.Err()
	case msg, ok := <-h.Events:
		if !ok {
			return ControlMessage{}, errors.New("control socket closed")
		}
		return msg, nil
	}
}

func (h *Host) WaitEvent(ctx context.Context, typ, connectionID string) (ControlMessage, error) {
	for {
		msg, err := h.NextEvent(ctx)
		if err != nil {
			return msg, err
		}
		if msg.Type == typ && (connectionID == "" || msg.ConnectionID == connectionID) {
			return msg, nil
		}
	}
}

func (h *Host) Accept(ctx context.Context, connectionID, token string) (*websocket.Conn, *http.Response, error) {
	return Dialer.DialContext(ctx, AcceptURL(h.Base, h.Identity.EndpointID, connectionID, token), nil)
}

func (h *Host) Close() error {
	var err error
	h.closedOnce.Do(func() {
		h.Control.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""), time.Now().Add(time.Second))
		select {
		case readErr := <-h.ReadErr:
			var ce *websocket.CloseError
			if !errors.As(readErr, &ce) {
				err = readErr
			}
		case <-time.After(5 * time.Second):
			err = errors.New("timed out waiting for relay close frame")
		}
		h.Control.Close()
	})
	return err
}

func CloseAndWait(conn *websocket.Conn, code int, reason string, timeout time.Duration) (int, string, error) {
	CloseWith(conn, code, reason)
	return ReadClose(conn, timeout)
}

func ReadClose(conn *websocket.Conn, timeout time.Duration) (int, string, error) {
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(timeout))
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			var ce *websocket.CloseError
			if errors.As(err, &ce) {
				return ce.Code, ce.Text, nil
			}
			return 0, "", err
		}
	}
}

func (h *Host) ServeEcho(ctx context.Context) {
	for {
		msg, err := h.WaitEvent(ctx, "incoming", "")
		if err != nil {
			return
		}
		go func() {
			conn, _, err := h.Accept(ctx, msg.ConnectionID, msg.Token)
			if err != nil {
				return
			}
			Echo(conn)
		}()
	}
}

func Echo(conn *websocket.Conn) {
	defer conn.Close()
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if err := conn.WriteMessage(mt, data); err != nil {
			return
		}
	}
}

func Connect(ctx context.Context, base, endpointID string) (*websocket.Conn, *http.Response, error) {
	return Dialer.DialContext(ctx, ConnectURL(base, endpointID), nil)
}

func CloseWith(conn *websocket.Conn, code int, reason string) {
	conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, reason), time.Now().Add(time.Second))
}
