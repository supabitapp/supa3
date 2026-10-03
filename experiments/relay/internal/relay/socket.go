package relay

import (
	"errors"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

type socket struct {
	conn     *websocket.Conn
	out      *queue
	cfg      Config
	done     chan struct{}
	finished chan struct{}
	once     sync.Once
	code     int
	reason   string
	onError  func(int, string)
	onWrite  func(int)
}

func newSocket(c *websocket.Conn, q *queue, cfg Config) *socket {
	s := &socket{conn: c, out: q, cfg: cfg, done: make(chan struct{}), finished: make(chan struct{})}
	c.SetReadLimit(int64(cfg.MaxMessageBytes))
	c.SetReadDeadline(time.Now().Add(3 * cfg.Heartbeat))
	c.SetPongHandler(func(string) error { return c.SetReadDeadline(time.Now().Add(3 * cfg.Heartbeat)) })
	c.SetPingHandler(func(v string) error {
		return c.WriteControl(websocket.PongMessage, []byte(v), time.Now().Add(cfg.WriteTimeout))
	})
	c.SetCloseHandler(func(int, string) error { return nil })
	return s
}

func (s *socket) stop(code int, reason string) {
	s.once.Do(func() { s.code = code; s.reason = reason; s.out.close(); close(s.done) })
}

func (s *socket) writer() {
	ticker := time.NewTicker(s.cfg.Heartbeat)
	defer ticker.Stop()
	defer close(s.finished)
	defer s.conn.Close()
	defer s.out.close()
	for {
		select {
		case <-s.done:
			s.conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(s.code, s.reason), time.Now().Add(min(s.cfg.WriteTimeout, 250*time.Millisecond)))
			return
		default:
		}
		select {
		case <-s.done:
			continue
		case <-ticker.C:
			if err := s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(s.cfg.WriteTimeout)); err != nil {
				s.onError(1011, "heartbeat write failed")
				return
			}
		case m := <-s.out.items:
			s.conn.SetWriteDeadline(time.Now().Add(s.cfg.WriteTimeout))
			err := s.conn.WriteMessage(m.kind, m.body)
			s.out.release(m)
			if err != nil {
				s.onError(1011, "write failed")
				return
			}
			if s.onWrite != nil {
				s.onWrite(len(m.body))
			}
		}
	}
}

func closeStatus(err error) (int, string) {
	if errors.Is(err, websocket.ErrReadLimit) {
		return 1009, "message too large"
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		if ce.Code >= 3000 && ce.Code <= 4999 || ce.Code == 1000 || ce.Code == 1001 || ce.Code == 1002 || ce.Code == 1003 || ce.Code >= 1007 && ce.Code <= 1014 {
			if utf8.ValidString(ce.Text) && len(ce.Text) <= 123 {
				return ce.Code, ce.Text
			}
		}
	}
	return 1011, "connection lost"
}

func (s *socket) reader(target *queue) {
	for {
		kind, body, err := s.conn.ReadMessage()
		if err != nil {
			s.onError(closeStatus(err))
			return
		}
		if kind == websocket.TextMessage && !utf8.Valid(body) {
			s.onError(1007, "invalid text")
			return
		}
		if target == nil {
			s.onError(1008, "unexpected control message")
			return
		}
		if !target.push(message{kind, body}) {
			s.onError(1013, "queue limit")
			return
		}
	}
}
