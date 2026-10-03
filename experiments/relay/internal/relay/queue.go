package relay

import "sync/atomic"

type message struct {
	messageType int
	data        []byte
}

type queue struct {
	ch       chan message
	bytes    atomic.Int64
	maxBytes int64
}

func newQueue(maxMessages int, maxBytes int64) *queue {
	return &queue{ch: make(chan message, maxMessages), maxBytes: maxBytes}
}

func (q *queue) push(m message) bool {
	n := int64(len(m.data))
	if q.bytes.Add(n) > q.maxBytes {
		q.bytes.Add(-n)
		return false
	}
	select {
	case q.ch <- m:
		return true
	default:
		q.bytes.Add(-n)
		return false
	}
}

func (q *queue) release(m message) {
	q.bytes.Add(-int64(len(m.data)))
}
