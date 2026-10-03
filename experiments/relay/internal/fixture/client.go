package fixture

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"time"

	"github.com/gorilla/websocket"
)

type Record struct {
	Type         string `json:"type"`
	Nonce        string `json:"nonce"`
	EndpointID   string `json:"endpointId"`
	ConnectionID string `json:"connectionId"`
	Token        string `json:"token"`
}

type Host struct {
	Address, ID string
	Key         ed25519.PrivateKey
	Control     *websocket.Conn
	Records     chan Record
	Done        chan struct{}
}

func Encode(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func Identity(key ed25519.PrivateKey) string {
	hash := sha256.Sum256(key.Public().(ed25519.PublicKey))
	return hex.EncodeToString(hash[:])
}

func Dial(address, path string, query url.Values) (*websocket.Conn, int, error) {
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, ReadBufferSize: 4096, WriteBufferSize: 4096}
	c, response, err := dialer.Dial("ws://"+address+path+"?"+query.Encode(), nil)
	code := 0
	if response != nil {
		code = response.StatusCode
		if response.Body != nil {
			response.Body.Close()
		}
	}
	if err != nil {
		return nil, code, errors.New("websocket admission failed")
	}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c, code, nil
}

func Register(address string, key ed25519.PrivateKey) (*Host, error) {
	if key == nil {
		_, key, _ = ed25519.GenerateKey(rand.Reader)
	}
	c, _, err := Dial(address, "/v1/control", url.Values{"publicKey": {Encode(key.Public().(ed25519.PublicKey))}})
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Host, error) { c.Close(); return nil, err }
	var challenge Record
	if err := c.ReadJSON(&challenge); err != nil {
		return fail(err)
	}
	if challenge.Type != "challenge" {
		return fail(errors.New("missing challenge"))
	}
	signature := ed25519.Sign(key, []byte("passio-relay-v1\n"+Identity(key)+"\n"+challenge.Nonce))
	if err := c.WriteJSON(map[string]string{"type": "authenticate", "signature": Encode(signature)}); err != nil {
		return fail(err)
	}
	var registered Record
	if err := c.ReadJSON(&registered); err != nil {
		return fail(err)
	}
	if registered.Type != "registered" || registered.EndpointID != Identity(key) {
		return fail(errors.New("incorrect registration"))
	}
	c.SetReadDeadline(time.Time{})
	h := &Host{address, registered.EndpointID, key, c, make(chan Record, 4096), make(chan struct{})}
	go func() {
		defer close(h.Done)
		defer close(h.Records)
		for {
			var r Record
			if c.ReadJSON(&r) != nil {
				return
			}
			h.Records <- r
		}
	}()
	return h, nil
}

func (h *Host) Next(ctx context.Context, kind string) (Record, error) {
	select {
	case r, ok := <-h.Records:
		if !ok || r.Type != kind {
			return Record{}, errors.New("unexpected control event")
		}
		return r, nil
	case <-ctx.Done():
		return Record{}, ctx.Err()
	}
}

func (h *Host) Connect() (*websocket.Conn, error) {
	c, _, err := Dial(h.Address, "/v1/connect", url.Values{"endpointId": {h.ID}})
	return c, err
}

func (h *Host) Accept(r Record) (*websocket.Conn, int, error) {
	return Dial(h.Address, "/v1/accept", url.Values{"endpointId": {h.ID}, "connectionId": {r.ConnectionID}, "token": {r.Token}})
}

func (h *Host) Pair(ctx context.Context) (*websocket.Conn, *websocket.Conn, error) {
	c, err := h.Connect()
	if err != nil {
		return nil, nil, err
	}
	r, err := h.Next(ctx, "incoming")
	if err != nil {
		c.Close()
		return nil, nil, err
	}
	a, _, err := h.Accept(r)
	if err != nil {
		c.Close()
		return nil, nil, err
	}
	return c, a, nil
}

func Echo(c *websocket.Conn) error {
	defer c.Close()
	c.SetReadDeadline(time.Time{})
	for {
		kind, data, err := c.ReadMessage()
		if err != nil {
			return err
		}
		c.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := c.WriteMessage(kind, data); err != nil {
			return err
		}
	}
}

func EchoHandler(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(*http.Request) bool { return true }}
	c, err := upgrader.Upgrade(w, r, nil)
	if err == nil {
		Echo(c)
	}
}
