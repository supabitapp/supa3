package relay

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type record struct {
	Type         string `json:"type"`
	Nonce        string `json:"nonce,omitempty"`
	Signature    string `json:"signature,omitempty"`
	EndpointID   string `json:"endpointId,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Token        string `json:"token,omitempty"`
}

type host struct {
	id      string
	control *socket
	pairs   map[string]*pair
	pending int
}

type pair struct {
	id, token                 string
	host                      *host
	client, accepted          *socket
	toClient, toHost          *queue
	expires                   time.Time
	timer                     *time.Timer
	claimed, paired, released bool
}

type bucket struct {
	tokens float64
	seen   time.Time
}

type Server struct {
	cfg               Config
	mu                sync.Mutex
	hosts             map[string]*host
	controls          map[*host]struct{}
	pairs             map[string]*pair
	ips               map[string]bucket
	lastSweep         time.Time
	draining          bool
	changed           chan struct{}
	forwardedMessages atomic.Uint64
	forwardedBytes    atomic.Uint64
	rejected          atomic.Uint64
}

func New(c Config) *Server {
	return &Server{cfg: c, hosts: make(map[string]*host), controls: make(map[*host]struct{}), pairs: make(map[string]*pair), ips: make(map[string]bucket), changed: make(chan struct{}, 1)}
}

func canonical(v string, size int) ([]byte, bool) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(v)
	return b, err == nil && len(b) == size && base64.RawURLEncoding.EncodeToString(b) == v
}

func randomID(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func endpointOK(id string) bool {
	b, err := hex.DecodeString(id)
	return err == nil && len(b) == 32 && hex.EncodeToString(b) == id
}

func send(s *socket, r record) bool {
	b, _ := json.Marshal(r)
	return s.out.push(message{websocket.TextMessage, b})
}

func (s *Server) reject(w http.ResponseWriter, code int) {
	s.rejected.Add(1)
	http.Error(w, http.StatusText(code), code)
}

func (s *Server) admit(w http.ResponseWriter, r *http.Request) bool {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		s.reject(w, 400)
		return false
	}
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.draining {
		s.reject(w, 503)
		return false
	}
	if now.Sub(s.lastSweep) >= time.Second {
		for key, b := range s.ips {
			if now.Sub(b.seen) >= time.Minute {
				delete(s.ips, key)
			}
		}
		s.lastSweep = now
	}
	b, exists := s.ips[ip]
	if !exists {
		if len(s.ips) >= 4096 {
			s.reject(w, 429)
			return false
		}
		b = bucket{float64(s.cfg.AdmissionRate), now}
	}
	b.tokens = min(float64(s.cfg.AdmissionRate), b.tokens+now.Sub(b.seen).Seconds()*float64(s.cfg.AdmissionRate))
	b.seen = now
	allowed := b.tokens >= 1
	if allowed {
		b.tokens--
	}
	s.ips[ip] = b
	if !allowed {
		s.reject(w, 429)
	}
	return allowed
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		s.reject(w, 405)
		return
	}
	switch r.URL.Path {
	case "/healthz":
		s.mu.Lock()
		draining := s.draining
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if draining {
			w.WriteHeader(503)
		}
		json.NewEncoder(w).Encode(map[string]string{"status": map[bool]string{false: "ok", true: "draining"}[draining]})
	case "/metrics":
		s.mu.Lock()
		active, pending := 0, 0
		for _, p := range s.pairs {
			if p.paired {
				active++
			} else {
				pending++
			}
		}
		values := map[string]uint64{"activeHosts": uint64(len(s.hosts)), "activePairs": uint64(active), "pendingPairs": uint64(pending), "forwardedMessages": s.forwardedMessages.Load(), "forwardedBytes": s.forwardedBytes.Load(), "rejectedConnections": s.rejected.Load()}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(values)
	case "/v1/control", "/v1/connect", "/v1/accept":
		if !s.admit(w, r) {
			return
		}
		switch r.URL.Path {
		case "/v1/control":
			s.control(w, r)
		case "/v1/connect":
			s.connect(w, r)
		case "/v1/accept":
			s.accept(w, r)
		}
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request, q *queue) *socket {
	u := websocket.Upgrader{HandshakeTimeout: s.cfg.WriteTimeout, ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(*http.Request) bool { return true }}
	c, err := u.Upgrade(w, r, nil)
	if err != nil {
		s.rejected.Add(1)
		return nil
	}
	return newSocket(c, q, s.cfg)
}

func (s *Server) control(w http.ResponseWriter, r *http.Request) {
	key, ok := canonical(r.URL.Query().Get("publicKey"), ed25519.PublicKeySize)
	if !ok {
		s.reject(w, 400)
		return
	}
	digest := sha256.Sum256(key)
	h := &host{id: hex.EncodeToString(digest[:]), pairs: make(map[string]*pair)}
	s.mu.Lock()
	if s.draining || len(s.controls) >= s.cfg.MaxClients {
		s.mu.Unlock()
		s.reject(w, 503)
		return
	}
	s.controls[h] = struct{}{}
	s.mu.Unlock()
	c := s.upgrade(w, r, newQueue(65536, 256))
	if c == nil {
		s.dropHost(h, 1011, "upgrade failed")
		return
	}
	s.mu.Lock()
	h.control = c
	_, live := s.controls[h]
	s.mu.Unlock()
	c.onError = func(code int, reason string) { s.dropHost(h, code, reason) }
	go c.writer()
	if !live {
		c.stop(1001, "draining")
		return
	}
	nonce := randomID(32)
	expires := time.Now().Add(s.cfg.AuthTimeout)
	c.conn.SetReadLimit(4096)
	c.conn.SetPongHandler(func(string) error { return nil })
	c.conn.SetReadDeadline(expires)
	send(c, record{Type: "challenge", Nonce: nonce})
	kind, data, err := c.conn.ReadMessage()
	var auth record
	signatureOK := json.Unmarshal(data, &auth) == nil && auth.Type == "authenticate"
	sig, canonicalSig := canonical(auth.Signature, ed25519.SignatureSize)
	signed := []byte("passio-relay-v1\n" + h.id + "\n" + nonce)
	if err != nil || kind != websocket.TextMessage || !signatureOK || !canonicalSig || !time.Now().Before(expires) || !ed25519.Verify(key, signed, sig) {
		s.rejected.Add(1)
		s.dropHost(h, 1008, "authentication failed")
		return
	}
	s.mu.Lock()
	_, live = s.controls[h]
	if !live || s.draining || s.hosts[h.id] != nil {
		s.mu.Unlock()
		s.rejected.Add(1)
		s.dropHost(h, 1008, "registration refused")
		return
	}
	s.hosts[h.id] = h
	send(c, record{Type: "registered", EndpointID: h.id})
	s.mu.Unlock()
	c.conn.SetReadDeadline(time.Now().Add(3 * s.cfg.Heartbeat))
	c.conn.SetPongHandler(func(string) error { return c.conn.SetReadDeadline(time.Now().Add(3 * s.cfg.Heartbeat)) })
	c.reader(nil)
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("endpointId")
	if !endpointOK(id) {
		s.reject(w, 400)
		return
	}
	s.mu.Lock()
	h := s.hosts[id]
	if h == nil {
		s.mu.Unlock()
		s.reject(w, 404)
		return
	}
	if s.draining || len(s.pairs) >= s.cfg.MaxClients || len(h.pairs) >= s.cfg.MaxClientsPerHost || h.pending >= s.cfg.MaxPendingPerHost {
		s.mu.Unlock()
		s.reject(w, 503)
		return
	}
	p := &pair{id: randomID(16), token: randomID(32), host: h, toClient: newQueue(s.cfg.MaxQueueBytes, s.cfg.MaxQueueMessages), toHost: newQueue(s.cfg.MaxQueueBytes, s.cfg.MaxQueueMessages), expires: time.Now().Add(s.cfg.PairTimeout)}
	s.pairs[p.id] = p
	h.pairs[p.id] = p
	h.pending++
	p.timer = time.AfterFunc(s.cfg.PairTimeout, func() { s.releasePending(p) })
	s.mu.Unlock()
	c := s.upgrade(w, r, p.toClient)
	if c == nil {
		s.release(p, 1011, "upgrade failed")
		return
	}
	c.onError = func(code int, reason string) { s.release(p, code, reason) }
	c.onWrite = s.countWrite
	s.mu.Lock()
	p.client = c
	live := !p.released
	notified := live && send(h.control, record{Type: "incoming", ConnectionID: p.id, Token: p.token})
	s.mu.Unlock()
	go c.writer()
	if !live {
		c.stop(1013, "pair expired")
		return
	}
	if !notified {
		s.dropHost(h, 1013, "control queue limit")
		return
	}
	c.reader(p.toHost)
}

func (s *Server) accept(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	id, connectionID, token := q.Get("endpointId"), q.Get("connectionId"), q.Get("token")
	_, tokenOK := canonical(token, 32)
	_, connectionOK := canonical(connectionID, 16)
	if !endpointOK(id) || !tokenOK || !connectionOK {
		s.reject(w, 403)
		return
	}
	s.mu.Lock()
	p := s.pairs[connectionID]
	if s.draining || p == nil || p.host.id != id || s.hosts[id] != p.host || p.client == nil || p.claimed || !time.Now().Before(p.expires) || subtle.ConstantTimeCompare([]byte(p.token), []byte(token)) != 1 {
		s.mu.Unlock()
		s.reject(w, 403)
		return
	}
	p.claimed = true
	p.token = ""
	s.mu.Unlock()
	c := s.upgrade(w, r, p.toHost)
	if c == nil {
		s.release(p, 1011, "upgrade failed")
		return
	}
	c.onError = func(code int, reason string) { s.release(p, code, reason) }
	c.onWrite = s.countWrite
	s.mu.Lock()
	p.accepted = c
	live := !p.released
	if live {
		p.paired = true
		p.host.pending--
		p.timer.Stop()
	}
	s.mu.Unlock()
	go c.writer()
	if !live {
		c.stop(1013, "pair expired")
		return
	}
	c.reader(p.toClient)
}

func (s *Server) countWrite(n int) {
	s.forwardedMessages.Add(1)
	s.forwardedBytes.Add(uint64(n))
}

func (s *Server) releasePending(p *pair) {
	s.releasePair(p, 1013, "pair timeout", true)
}

func (s *Server) release(p *pair, code int, reason string) {
	s.releasePair(p, code, reason, false)
}

func (s *Server) releasePair(p *pair, code int, reason string, pendingOnly bool) {
	s.mu.Lock()
	if p.released || pendingOnly && p.paired {
		s.mu.Unlock()
		return
	}
	p.released = true
	p.timer.Stop()
	delete(s.pairs, p.id)
	delete(p.host.pairs, p.id)
	if !p.paired {
		p.host.pending--
	}
	p.toHost.close()
	p.toClient.close()
	if p.client != nil {
		p.client.stop(code, reason)
	}
	if p.accepted != nil {
		p.accepted.stop(code, reason)
	}
	notifyFailed := false
	if s.hosts[p.host.id] == p.host {
		notifyFailed = !send(p.host.control, record{Type: "closed", ConnectionID: p.id})
	}
	select {
	case s.changed <- struct{}{}:
	default:
	}
	s.mu.Unlock()
	if notifyFailed {
		s.dropHost(p.host, 1013, "control queue limit")
	}
}

func (s *Server) dropHost(h *host, code int, reason string) {
	s.mu.Lock()
	delete(s.controls, h)
	if s.hosts[h.id] == h {
		delete(s.hosts, h.id)
	}
	if h.control != nil {
		h.control.stop(code, reason)
	}
	pairs := make([]*pair, 0, len(h.pairs))
	for _, p := range h.pairs {
		pairs = append(pairs, p)
	}
	s.mu.Unlock()
	for _, p := range pairs {
		s.release(p, code, reason)
	}
}

func (s *Server) BeginDrain() {
	s.mu.Lock()
	s.draining = true
	pending := make([]*pair, 0)
	for _, p := range s.pairs {
		if !p.paired {
			pending = append(pending, p)
		}
	}
	s.mu.Unlock()
	for _, p := range pending {
		s.release(p, 1001, "draining")
	}
}

func (s *Server) Drain(ctx context.Context) {
	s.BeginDrain()
	for {
		s.mu.Lock()
		count := len(s.pairs)
		s.mu.Unlock()
		if count == 0 {
			break
		}
		select {
		case <-s.changed:
		case <-ctx.Done():
			goto finish
		}
	}
finish:
	s.mu.Lock()
	hosts := make([]*host, 0, len(s.controls))
	for h := range s.controls {
		hosts = append(hosts, h)
	}
	s.mu.Unlock()
	for _, h := range hosts {
		s.dropHost(h, 1001, "draining")
	}
}
