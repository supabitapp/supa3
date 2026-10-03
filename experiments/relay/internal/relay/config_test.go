package relay

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"
)

func TestConfigValidation(t *testing.T) {
	names := []string{"RELAY_MAX_MESSAGE_BYTES", "RELAY_MAX_QUEUE_BYTES", "RELAY_MAX_QUEUE_MESSAGES", "RELAY_MAX_CLIENTS", "RELAY_MAX_CLIENTS_PER_HOST", "RELAY_MAX_PENDING_PER_HOST", "RELAY_AUTH_TIMEOUT_MS", "RELAY_PAIR_TIMEOUT_MS", "RELAY_WRITE_TIMEOUT_MS", "RELAY_HEARTBEAT_MS", "RELAY_ADMISSION_RATE"}
	for _, name := range names {
		for _, value := range []string{"", "0", "-1", "x", "99999999999999999999"} {
			t.Run(name+"/"+value, func(t *testing.T) {
				t.Setenv(name, value)
				if _, err := LoadConfig(); err == nil {
					t.Fatal("invalid config accepted")
				}
			})
		}
	}
	for _, value := range []string{"", ":8080", "localhost:-1", "localhost:65536", "localhost:x", "no-port"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("RELAY_ADDR", value)
			if _, err := LoadConfig(); err == nil {
				t.Fatal("invalid address accepted")
			}
		})
	}
	t.Setenv("RELAY_ADDR", "127.0.0.1:0")
	if c, err := LoadConfig(); err != nil || c.Heartbeat != 15*time.Second {
		t.Fatalf("defaults: %v", err)
	}
}

func TestQueueIncludesInflight(t *testing.T) {
	q := newQueue(4, 2)
	if !q.push(message{2, []byte("abcd")}) {
		t.Fatal("initial queue rejected")
	}
	inFlight := <-q.items
	if q.push(message{2, []byte("e")}) {
		t.Fatal("inflight bytes not counted")
	}
	q.release(inFlight)
	if !q.push(message{2, nil}) || !q.push(message{2, nil}) || q.push(message{2, nil}) {
		t.Fatal("empty message count limit failed")
	}
	q.close()
	if q.push(message{2, nil}) {
		t.Fatal("closed queue accepted data")
	}
}

func TestAdmissionBookkeepingBoundAndExpiry(t *testing.T) {
	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	s := New(cfg)
	for i := 0; i < 4096; i++ {
		s.ips[fmt.Sprint(i)] = bucket{tokens: 1, seen: time.Now()}
	}
	request := httptest.NewRequest("GET", "/v1/connect", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	response := httptest.NewRecorder()
	if s.admit(response, request) || response.Code != 429 || len(s.ips) != 4096 {
		t.Fatal("admission table exceeded its bound")
	}
	for key, b := range s.ips {
		b.seen = time.Now().Add(-2 * time.Minute)
		s.ips[key] = b
	}
	s.lastSweep = time.Now().Add(-time.Second)
	if !s.admit(httptest.NewRecorder(), request) || len(s.ips) != 1 {
		t.Fatal("expired IP buckets were retained")
	}
}
