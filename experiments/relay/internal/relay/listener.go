package relay

import (
	"net"
	"sync"
)

type Listener struct {
	net.Listener
	mu          sync.Mutex
	connections map[*countedConn]struct{}
	limit       int
}

type countedConn struct {
	net.Conn
	owner *Listener
	once  sync.Once
}

func LimitListener(l net.Listener, limit int) *Listener {
	return &Listener{Listener: l, connections: make(map[*countedConn]struct{}), limit: limit}
}

func (l *Listener) Accept() (net.Conn, error) {
	for {
		c, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		l.mu.Lock()
		if len(l.connections) >= l.limit {
			l.mu.Unlock()
			c.Close()
			continue
		}
		wrapped := &countedConn{Conn: c, owner: l}
		l.connections[wrapped] = struct{}{}
		l.mu.Unlock()
		return wrapped, nil
	}
}

func (c *countedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.connections, c); c.owner.mu.Unlock() })
	return err
}

func (l *Listener) CloseConnections() {
	l.mu.Lock()
	connections := make([]*countedConn, 0, len(l.connections))
	for c := range l.connections {
		connections = append(connections, c)
	}
	l.mu.Unlock()
	for _, c := range connections {
		c.Close()
	}
}
