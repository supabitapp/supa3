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
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const signaturePrefix = "passio-relay-v1\n"

type Relay struct {
	cfg      Config
	log      *slog.Logger
	upgrader websocket.Upgrader
	limiter  *ipLimiter
	Metrics  Metrics
	draining atomic.Bool

	closing atomic.Int64

	mu           sync.Mutex
	hosts        map[string]*host
	totalClients int
	generation   uint64
}

type hostState int

const (
	hostActive hostState = iota
	hostClosed
)

type host struct {
	endpointID string
	generation uint64
	sock       *socket
	pairs      map[string]*pair
	pending    int
	out        chan []byte
	state      hostState
	done       chan struct{}
}

type pairState int

const (
	pairPending pairState = iota
	pairAccepting
	pairActive
	pairClosed
)

type pair struct {
	id       string
	token    []byte
	host     *host
	client   *socket
	hostSock *socket
	state    pairState
	c2h      *queue
	h2c      *queue
	timer    *time.Timer
	done     chan struct{}
}

func New(cfg Config, logger *slog.Logger) *Relay {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	return &Relay{
		cfg: cfg,
		log: logger,
		upgrader: websocket.Upgrader{
			HandshakeTimeout: 10 * time.Second,
			CheckOrigin:      func(*http.Request) bool { return true },
		},
		limiter: newIPLimiter(cfg.AdmissionRate, cfg.AdmissionRate*AdmissionBurstFactor, 65536),
		hosts:   make(map[string]*host),
	}
}

func (r *Relay) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", r.handleHealth)
	mux.HandleFunc("GET /metrics", r.handleMetrics)
	mux.HandleFunc("GET /v1/control", r.handleControl)
	mux.HandleFunc("GET /v1/connect", r.handleConnect)
	mux.HandleFunc("GET /v1/accept", r.handleAccept)
	return mux
}

func (r *Relay) Draining() bool { return r.draining.Load() }

func (r *Relay) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.draining.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"draining"}`))
		return
	}
	w.Write([]byte(`{"status":"ok"}`))
}

func (r *Relay) handleMetrics(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(r.Metrics.snapshot(r.draining.Load()))
}

func (r *Relay) reject(w http.ResponseWriter, status int, msg string) {
	r.Metrics.RejectedConnections.Add(1)
	http.Error(w, msg, status)
}

func (r *Relay) admit(w http.ResponseWriter, req *http.Request, allowDuringDrain bool) bool {
	if !allowDuringDrain && r.draining.Load() {
		r.reject(w, http.StatusServiceUnavailable, "relay is draining")
		return false
	}
	if !r.limiter.allow(clientIP(req, r.cfg.TrustForwardedFor), time.Now()) {
		r.reject(w, http.StatusTooManyRequests, "admission rate exceeded")
		return false
	}
	return true
}

func clientIP(req *http.Request, trustForwarded bool) string {
	if trustForwarded {
		if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	ip, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return ip
}

func decodeCanonical(s string, size int) ([]byte, bool) {
	if s == "" {
		return nil, false
	}
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != size || base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, false
	}
	return b, true
}

func randomToken(size int) (string, []byte) {
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b), b
}

func EndpointID(publicKey ed25519.PublicKey) string {
	sum := sha256.Sum256(publicKey)
	return hex.EncodeToString(sum[:])
}

func SignedBytes(endpointID, nonce string) []byte {
	return []byte(signaturePrefix + endpointID + "\n" + nonce)
}

type controlMessage struct {
	Type         string `json:"type"`
	Nonce        string `json:"nonce,omitempty"`
	Signature    string `json:"signature,omitempty"`
	EndpointID   string `json:"endpointId,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Token        string `json:"token,omitempty"`
}

func encode(m controlMessage) []byte {
	b, _ := json.Marshal(m)
	return b
}

func (r *Relay) handleControl(w http.ResponseWriter, req *http.Request) {
	if !r.admit(w, req, false) {
		return
	}
	pub, ok := decodeCanonical(req.URL.Query().Get("publicKey"), ed25519.PublicKeySize)
	if !ok {
		r.reject(w, http.StatusBadRequest, "publicKey must be canonical unpadded base64url of a 32-byte key")
		return
	}
	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		r.Metrics.RejectedConnections.Add(1)
		return
	}
	sock := newSocket(conn, r.cfg, controlMessageLimit)
	endpointID := EndpointID(pub)
	nonce, _ := randomToken(32)
	if err := sock.write(websocket.TextMessage, encode(controlMessage{Type: "challenge", Nonce: nonce})); err != nil {
		sock.closeNow()
		return
	}
	conn.SetReadDeadline(time.Now().Add(r.cfg.AuthTimeout))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		r.rejectControl(sock, "authentication timeout")
		return
	}
	var auth controlMessage
	if mt != websocket.TextMessage || json.Unmarshal(data, &auth) != nil || auth.Type != "authenticate" {
		r.rejectControl(sock, "expected authenticate message")
		return
	}
	sig, ok := decodeCanonical(auth.Signature, ed25519.SignatureSize)
	if !ok || !ed25519.Verify(pub, SignedBytes(endpointID, nonce), sig) {
		r.rejectControl(sock, "invalid signature")
		return
	}
	conn.SetReadDeadline(time.Now().Add(pongWait(r.cfg.Heartbeat)))

	h := &host{
		endpointID: endpointID,
		sock:       sock,
		pairs:      make(map[string]*pair),
		out:        make(chan []byte, 2*r.cfg.MaxClientsPerHost+16),
		done:       make(chan struct{}),
	}
	r.mu.Lock()
	if _, exists := r.hosts[endpointID]; exists {
		r.mu.Unlock()
		r.rejectControl(sock, "endpoint already registered")
		return
	}
	r.generation++
	h.generation = r.generation
	r.hosts[endpointID] = h
	r.mu.Unlock()
	r.Metrics.ActiveHosts.Add(1)
	r.log.Info("host registered", "endpointId", endpointID, "generation", h.generation)

	if err := sock.write(websocket.TextMessage, encode(controlMessage{Type: "registered", EndpointID: endpointID})); err != nil {
		r.closeHost(h, websocket.CloseInternalServerErr, "control write failed")
		return
	}
	go r.hostWriter(h)
	go sock.runHeartbeat(h.done, func() { r.closeHost(h, websocket.CloseInternalServerErr, "heartbeat failed") })
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			sock.markReadDone()
			code, reason := closeCodeFor(err)
			r.closeHost(h, code, reason)
			return
		}
		sock.markReadDone()
		r.closeHost(h, websocket.ClosePolicyViolation, "unexpected control message")
		return
	}
}

func (r *Relay) rejectControl(sock *socket, reason string) {
	r.Metrics.RejectedConnections.Add(1)
	go sock.close(websocket.ClosePolicyViolation, reason)
	sock.conn.ReadMessage()
	sock.markReadDone()
}

func (r *Relay) hostWriter(h *host) {
	for {
		select {
		case <-h.done:
			return
		case msg := <-h.out:
			if err := h.sock.write(websocket.TextMessage, msg); err != nil {
				r.closeHost(h, websocket.CloseTryAgainLater, "control write timeout")
				return
			}
		}
	}
}

func (h *host) send(msg []byte) bool {
	select {
	case h.out <- msg:
		return true
	default:
		return false
	}
}

func (r *Relay) closeHost(h *host, code int, reason string) {
	r.mu.Lock()
	if h.state == hostClosed {
		r.mu.Unlock()
		return
	}
	h.state = hostClosed
	close(h.done)
	if r.hosts[h.endpointID] == h {
		delete(r.hosts, h.endpointID)
	}
	pairs := make([]*pair, 0, len(h.pairs))
	for _, p := range h.pairs {
		pairs = append(pairs, p)
	}
	r.mu.Unlock()
	r.Metrics.ActiveHosts.Add(-1)
	r.log.Info("host closed", "endpointId", h.endpointID, "generation", h.generation, "code", code, "reason", reason)
	r.spawnClose(h.sock, code, reason)
	for _, p := range pairs {
		r.closePair(p, websocket.CloseGoingAway, "host disconnected")
	}
}

func (r *Relay) handleConnect(w http.ResponseWriter, req *http.Request) {
	if !r.admit(w, req, false) {
		return
	}
	endpointID := req.URL.Query().Get("endpointId")
	r.mu.Lock()
	h := r.hosts[endpointID]
	if h == nil {
		r.mu.Unlock()
		r.reject(w, http.StatusNotFound, "no registered host for endpoint")
		return
	}
	switch {
	case r.totalClients >= r.cfg.MaxClients:
		r.mu.Unlock()
		r.reject(w, http.StatusServiceUnavailable, "relay client limit reached")
		return
	case len(h.pairs) >= r.cfg.MaxClientsPerHost:
		r.mu.Unlock()
		r.reject(w, http.StatusServiceUnavailable, "host client limit reached")
		return
	case h.pending >= r.cfg.MaxPendingPerHost:
		r.mu.Unlock()
		r.reject(w, http.StatusServiceUnavailable, "host pending limit reached")
		return
	}
	connectionID, _ := randomToken(16)
	token, tokenBytes := randomToken(32)
	p := &pair{
		id:    connectionID,
		token: tokenBytes,
		host:  h,
		c2h:   newQueue(r.cfg.MaxQueueMessages, r.cfg.MaxQueueBytes),
		h2c:   newQueue(r.cfg.MaxQueueMessages, r.cfg.MaxQueueBytes),
		done:  make(chan struct{}),
	}
	h.pairs[connectionID] = p
	h.pending++
	r.totalClients++
	r.mu.Unlock()
	r.Metrics.PendingPairs.Add(1)

	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		r.Metrics.RejectedConnections.Add(1)
		r.closePair(p, websocket.CloseInternalServerErr, "upgrade failed")
		return
	}
	sock := newSocket(conn, r.cfg, r.cfg.MaxMessageBytes)
	r.mu.Lock()
	if p.state == pairClosed {
		r.mu.Unlock()
		go sock.close(websocket.CloseGoingAway, "host disconnected")
		conn.ReadMessage()
		sock.markReadDone()
		return
	}
	p.client = sock
	p.timer = time.AfterFunc(r.cfg.PairTimeout, func() {
		r.closePairWhen(p, func(s pairState) bool { return s != pairActive }, websocket.CloseTryAgainLater, "pair timeout")
	})
	r.mu.Unlock()
	if !h.send(encode(controlMessage{Type: "incoming", ConnectionID: connectionID, Token: token})) {
		r.closeHost(h, websocket.CloseTryAgainLater, "control queue overflow")
	}
	go sock.runHeartbeat(p.done, func() { r.closePair(p, websocket.CloseInternalServerErr, "heartbeat failed") })
	r.pumpRead(p, sock, p.c2h)
}

func (r *Relay) handleAccept(w http.ResponseWriter, req *http.Request) {
	if !r.admit(w, req, true) {
		return
	}
	q := req.URL.Query()
	tokenBytes, ok := decodeCanonical(q.Get("token"), 32)
	if !ok {
		r.reject(w, http.StatusForbidden, "invalid token")
		return
	}
	r.mu.Lock()
	h := r.hosts[q.Get("endpointId")]
	if h == nil {
		r.mu.Unlock()
		r.reject(w, http.StatusNotFound, "no registered host for endpoint")
		return
	}
	p := h.pairs[q.Get("connectionId")]
	if p == nil || p.client == nil {
		r.mu.Unlock()
		r.reject(w, http.StatusNotFound, "unknown connection")
		return
	}
	if p.state != pairPending || subtle.ConstantTimeCompare(p.token, tokenBytes) != 1 {
		r.mu.Unlock()
		r.reject(w, http.StatusForbidden, "token rejected")
		return
	}
	p.state = pairAccepting
	r.mu.Unlock()

	conn, err := r.upgrader.Upgrade(w, req, nil)
	if err != nil {
		r.Metrics.RejectedConnections.Add(1)
		r.closePair(p, websocket.CloseInternalServerErr, "upgrade failed")
		return
	}
	sock := newSocket(conn, r.cfg, r.cfg.MaxMessageBytes)
	r.mu.Lock()
	if p.state != pairAccepting {
		r.mu.Unlock()
		go sock.close(websocket.CloseGoingAway, "pair closed")
		conn.ReadMessage()
		sock.markReadDone()
		return
	}
	p.state = pairActive
	p.hostSock = sock
	p.timer.Stop()
	h.pending--
	r.mu.Unlock()
	r.Metrics.PendingPairs.Add(-1)
	r.Metrics.ActivePairs.Add(1)

	go r.pumpWrite(p, sock, p.c2h)
	go r.pumpWrite(p, p.client, p.h2c)
	go sock.runHeartbeat(p.done, func() { r.closePair(p, websocket.CloseInternalServerErr, "heartbeat failed") })
	r.pumpRead(p, sock, p.h2c)
}

func (r *Relay) pumpRead(p *pair, src *socket, q *queue) {
	defer src.markReadDone()
	for {
		mt, data, err := src.conn.ReadMessage()
		if err != nil {
			if src.closing.Load() {
				return
			}
			code, reason := closeCodeFor(err)
			r.closePair(p, code, reason)
			return
		}
		if !q.push(message{messageType: mt, data: data}) {
			r.closePair(p, websocket.CloseTryAgainLater, "queue limit exceeded")
			return
		}
	}
}

func (r *Relay) pumpWrite(p *pair, dst *socket, q *queue) {
	for {
		select {
		case <-p.done:
			return
		case m := <-q.ch:
			q.release(m)
			if err := dst.write(m.messageType, m.data); err != nil {
				var ne net.Error
				if errors.As(err, &ne) && ne.Timeout() {
					r.closePair(p, websocket.CloseTryAgainLater, "slow consumer")
				} else {
					r.closePair(p, websocket.CloseInternalServerErr, "peer connection lost")
				}
				return
			}
			r.Metrics.ForwardedMessages.Add(1)
			r.Metrics.ForwardedBytes.Add(int64(len(m.data)))
		}
	}
}

func (r *Relay) closePair(p *pair, code int, reason string) {
	r.closePairWhen(p, func(pairState) bool { return true }, code, reason)
}

func (r *Relay) closePairWhen(p *pair, when func(pairState) bool, code int, reason string) {
	r.mu.Lock()
	if p.state == pairClosed || !when(p.state) {
		r.mu.Unlock()
		return
	}
	prev := p.state
	p.state = pairClosed
	close(p.done)
	if p.timer != nil {
		p.timer.Stop()
	}
	h := p.host
	delete(h.pairs, p.id)
	r.totalClients--
	if prev != pairActive {
		h.pending--
	}
	notify := h.state == hostActive
	client, hostSock := p.client, p.hostSock
	r.mu.Unlock()
	if prev == pairActive {
		r.Metrics.ActivePairs.Add(-1)
	} else {
		r.Metrics.PendingPairs.Add(-1)
	}
	if client != nil {
		r.spawnClose(client, code, reason)
	}
	if hostSock != nil {
		r.spawnClose(hostSock, code, reason)
	}
	if notify && !h.send(encode(controlMessage{Type: "closed", ConnectionID: p.id})) {
		r.closeHost(h, websocket.CloseTryAgainLater, "control queue overflow")
	}
}

func (r *Relay) spawnClose(s *socket, code int, reason string) {
	r.closing.Add(1)
	go func() {
		defer r.closing.Add(-1)
		s.close(code, reason)
	}()
}

func (r *Relay) Drain(ctx context.Context) {
	r.draining.Store(true)
	r.log.Info("draining")
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for r.Metrics.ActivePairs.Load()+r.Metrics.PendingPairs.Load() > 0 {
		select {
		case <-ctx.Done():
			r.CloseAll()
			return
		case <-ticker.C:
		}
	}
	r.CloseAll()
}

func (r *Relay) CloseAll() {
	r.mu.Lock()
	hosts := make([]*host, 0, len(r.hosts))
	for _, h := range r.hosts {
		hosts = append(hosts, h)
	}
	r.mu.Unlock()
	var wg sync.WaitGroup
	for _, h := range hosts {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r.closeHost(h, websocket.CloseGoingAway, "relay shutting down")
		}()
	}
	wg.Wait()
	settle := time.Now().Add(time.Second)
	for r.closing.Load() > 0 && time.Now().Before(settle) {
		time.Sleep(10 * time.Millisecond)
	}
}
