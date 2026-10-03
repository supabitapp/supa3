package relay

import "sync"

type message struct {
	kind int
	body []byte
}

type queue struct {
	mu                 sync.Mutex
	items              chan message
	bytes, count       int
	maxBytes, maxCount int
	closed             bool
}

func newQueue(bytes, count int) *queue {
	return &queue{items: make(chan message, count), maxBytes: bytes, maxCount: count}
}

func (q *queue) push(m message) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed || q.count >= q.maxCount || len(m.body) > q.maxBytes-q.bytes {
		return false
	}
	q.bytes += len(m.body)
	q.count++
	q.items <- m
	return true
}

func (q *queue) release(m message) {
	q.mu.Lock()
	q.bytes -= len(m.body)
	q.count--
	q.mu.Unlock()
}

func (q *queue) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed = true
	for {
		select {
		case m := <-q.items:
			q.bytes -= len(m.body)
			q.count--
		default:
			return
		}
	}
}
