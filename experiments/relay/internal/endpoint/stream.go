package endpoint

import (
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type StreamConn struct {
	ws        *websocket.Conn
	reader    io.Reader
	writeMu   sync.Mutex
	Intercept func(frame []byte) [][]byte
}

func NewStreamConn(ws *websocket.Conn) *StreamConn {
	return &StreamConn{ws: ws}
}

func (c *StreamConn) Read(p []byte) (int, error) {
	for {
		if c.reader != nil {
			n, err := c.reader.Read(p)
			if err == io.EOF {
				c.reader = nil
				if n == 0 {
					continue
				}
				return n, nil
			}
			return n, err
		}
		mt, data, err := c.ws.ReadMessage()
		if err != nil {
			return 0, err
		}
		if mt != websocket.BinaryMessage {
			continue
		}
		c.reader = &sliceReader{data: data}
	}
}

func (c *StreamConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	frames := [][]byte{p}
	if c.Intercept != nil {
		frames = c.Intercept(p)
	}
	for _, frame := range frames {
		if err := c.ws.WriteMessage(websocket.BinaryMessage, frame); err != nil {
			return 0, err
		}
	}
	return len(p), nil
}

func (c *StreamConn) Close() error         { return c.ws.Close() }
func (c *StreamConn) LocalAddr() net.Addr  { return c.ws.LocalAddr() }
func (c *StreamConn) RemoteAddr() net.Addr { return c.ws.RemoteAddr() }
func (c *StreamConn) SetDeadline(t time.Time) error {
	if err := c.ws.SetReadDeadline(t); err != nil {
		return err
	}
	return c.ws.SetWriteDeadline(t)
}
func (c *StreamConn) SetReadDeadline(t time.Time) error  { return c.ws.SetReadDeadline(t) }
func (c *StreamConn) SetWriteDeadline(t time.Time) error { return c.ws.SetWriteDeadline(t) }

type sliceReader struct {
	data []byte
	off  int
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.off >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.off:])
	r.off += n
	return n, nil
}
