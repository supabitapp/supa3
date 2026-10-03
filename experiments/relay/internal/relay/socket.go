package relay

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type socket struct {
	conn         *websocket.Conn
	writeTimeout time.Duration
	heartbeat    time.Duration
	once         sync.Once
	readDone     chan struct{}
	readOnce     sync.Once
	closing      atomic.Bool
}

const controlMessageLimit = 4096

func newSocket(conn *websocket.Conn, cfg Config, readLimit int64) *socket {
	s := &socket{conn: conn, writeTimeout: cfg.WriteTimeout, heartbeat: cfg.Heartbeat, readDone: make(chan struct{})}
	conn.SetReadLimit(readLimit)
	conn.SetReadDeadline(time.Now().Add(pongWait(cfg.Heartbeat)))
	conn.SetCloseHandler(func(int, string) error { return nil })
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait(cfg.Heartbeat)))
	})
	return s
}

func pongWait(heartbeat time.Duration) time.Duration {
	return 2 * heartbeat
}

func (s *socket) write(messageType int, data []byte) error {
	if err := s.conn.SetWriteDeadline(time.Now().Add(s.writeTimeout)); err != nil {
		return err
	}
	return s.conn.WriteMessage(messageType, data)
}

func (s *socket) ping() error {
	return s.conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(s.writeTimeout))
}

func (s *socket) runHeartbeat(done <-chan struct{}, onFail func()) {
	ticker := time.NewTicker(s.heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			if err := s.ping(); err != nil {
				onFail()
				return
			}
		}
	}
}

func (s *socket) markReadDone() {
	s.readOnce.Do(func() { close(s.readDone) })
}

func (s *socket) close(code int, reason string) {
	s.once.Do(func() {
		s.closing.Store(true)
		frame := websocket.FormatCloseMessage(code, truncateReason(reason))
		if err := s.conn.WriteControl(websocket.CloseMessage, frame, time.Now().Add(s.writeTimeout)); err == nil {
			select {
			case <-s.readDone:
			case <-time.After(s.writeTimeout):
			}
		}
		s.conn.Close()
	})
}

func (s *socket) closeNow() {
	s.once.Do(func() {
		s.closing.Store(true)
		s.conn.Close()
	})
}

func truncateReason(reason string) string {
	if len(reason) > 123 {
		return reason[:123]
	}
	return reason
}

func legalCloseCode(code int) bool {
	switch {
	case code == websocket.CloseNormalClosure, code == websocket.CloseGoingAway,
		code == websocket.CloseProtocolError, code == websocket.CloseUnsupportedData:
		return true
	case code >= websocket.CloseInvalidFramePayloadData && code <= websocket.CloseInternalServerErr:
		return true
	case code >= 3000 && code <= 4999:
		return true
	}
	return false
}

func closeCodeFor(err error) (int, string) {
	if errors.Is(err, websocket.ErrReadLimit) {
		return websocket.CloseMessageTooBig, "message exceeds relay limit"
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) && legalCloseCode(ce.Code) {
		return ce.Code, truncateReason(ce.Text)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return websocket.CloseInternalServerErr, "peer heartbeat timeout"
	}
	return websocket.CloseInternalServerErr, "peer connection lost"
}
