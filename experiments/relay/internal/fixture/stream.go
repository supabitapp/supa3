package fixture

import (
	"io"
	"net"
	"time"

	"github.com/gorilla/websocket"
)

type Stream struct {
	Conn      *websocket.Conn
	reader    io.Reader
	Transform func([]byte) [][]byte
}

func (s *Stream) Read(p []byte) (int, error) {
	for {
		if s.reader == nil {
			_, r, err := s.Conn.NextReader()
			if err != nil {
				return 0, err
			}
			s.reader = r
		}
		n, err := s.reader.Read(p)
		if err == io.EOF {
			s.reader = nil
			if n > 0 {
				return n, nil
			}
			continue
		}
		return n, err
	}
}

func (s *Stream) Write(p []byte) (int, error) {
	records := [][]byte{p}
	if s.Transform != nil {
		records = s.Transform(p)
	}
	for _, b := range records {
		if err := s.Conn.WriteMessage(websocket.BinaryMessage, b); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (s *Stream) Close() error         { return s.Conn.Close() }
func (s *Stream) LocalAddr() net.Addr  { return s.Conn.LocalAddr() }
func (s *Stream) RemoteAddr() net.Addr { return s.Conn.RemoteAddr() }
func (s *Stream) SetDeadline(t time.Time) error {
	s.Conn.SetReadDeadline(t)
	return s.Conn.SetWriteDeadline(t)
}
func (s *Stream) SetReadDeadline(t time.Time) error  { return s.Conn.SetReadDeadline(t) }
func (s *Stream) SetWriteDeadline(t time.Time) error { return s.Conn.SetWriteDeadline(t) }
