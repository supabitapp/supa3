package relay

import (
	"sync"
	"time"
)

type bucket struct {
	tokens float64
	last   time.Time
}

type ipLimiter struct {
	mu       sync.Mutex
	rate     float64
	burst    float64
	buckets  map[string]*bucket
	maxKeys  int
	lastSwep time.Time
}

func newIPLimiter(rate float64, burst float64, maxKeys int) *ipLimiter {
	return &ipLimiter{rate: rate, burst: burst, buckets: make(map[string]*bucket), maxKeys: maxKeys, lastSwep: time.Now()}
}

func (l *ipLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSwep) > time.Minute || len(l.buckets) >= l.maxKeys {
		l.sweep(now)
	}
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= l.maxKeys {
			return false
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() * l.rate
	if b.tokens > l.burst {
		b.tokens = l.burst
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (l *ipLimiter) sweep(now time.Time) {
	l.lastSwep = now
	refill := time.Duration(l.burst / l.rate * float64(time.Second))
	for k, b := range l.buckets {
		if now.Sub(b.last) > refill {
			delete(l.buckets, k)
		}
	}
}
