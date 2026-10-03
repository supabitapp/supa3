package relay

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr              string
	MaxMessageBytes   int
	MaxQueueBytes     int
	MaxQueueMessages  int
	MaxClients        int
	MaxClientsPerHost int
	MaxPendingPerHost int
	AuthTimeout       time.Duration
	PairTimeout       time.Duration
	WriteTimeout      time.Duration
	Heartbeat         time.Duration
	AdmissionRate     int
}

func LoadConfig() (Config, error) {
	c := Config{Addr: "127.0.0.1:8080"}
	if v, ok := os.LookupEnv("RELAY_ADDR"); ok {
		c.Addr = v
	}
	host, port, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return c, fmt.Errorf("invalid RELAY_ADDR")
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 0 || n > 65535 || host == "" {
		return c, fmt.Errorf("invalid RELAY_ADDR")
	}
	fields := []struct {
		name       string
		target     *int
		value, max int
	}{
		{"RELAY_MAX_MESSAGE_BYTES", &c.MaxMessageBytes, 1048576, 67108864},
		{"RELAY_MAX_QUEUE_BYTES", &c.MaxQueueBytes, 4194304, 268435456},
		{"RELAY_MAX_QUEUE_MESSAGES", &c.MaxQueueMessages, 256, 65536},
		{"RELAY_MAX_CLIENTS", &c.MaxClients, 1024, 100000},
		{"RELAY_MAX_CLIENTS_PER_HOST", &c.MaxClientsPerHost, 128, 100000},
		{"RELAY_MAX_PENDING_PER_HOST", &c.MaxPendingPerHost, 32, 100000},
		{"RELAY_ADMISSION_RATE", &c.AdmissionRate, 100, 1000000},
	}
	for _, f := range fields {
		*f.target = f.value
		if v, ok := os.LookupEnv(f.name); ok {
			n, err := strconv.Atoi(v)
			if err != nil || n < 1 || n > f.max {
				return c, fmt.Errorf("invalid %s (range 1..%d)", f.name, f.max)
			}
			*f.target = n
		}
	}
	durations := []struct {
		name   string
		target *time.Duration
		value  int
	}{
		{"RELAY_AUTH_TIMEOUT_MS", &c.AuthTimeout, 5000},
		{"RELAY_PAIR_TIMEOUT_MS", &c.PairTimeout, 5000},
		{"RELAY_WRITE_TIMEOUT_MS", &c.WriteTimeout, 5000},
		{"RELAY_HEARTBEAT_MS", &c.Heartbeat, 15000},
	}
	for _, f := range durations {
		n := f.value
		if v, ok := os.LookupEnv(f.name); ok {
			parsed, err := strconv.Atoi(v)
			if err != nil || parsed < 1 || parsed > 3600000 {
				return c, fmt.Errorf("invalid %s (range 1..3600000)", f.name)
			}
			n = parsed
		}
		*f.target = time.Duration(n) * time.Millisecond
	}
	return c, nil
}
