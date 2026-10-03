package relay

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Addr              string
	MaxMessageBytes   int64
	MaxQueueBytes     int64
	MaxQueueMessages  int
	MaxClients        int
	MaxHosts          int
	MaxClientsPerHost int
	MaxPendingPerHost int
	AuthTimeout       time.Duration
	PairTimeout       time.Duration
	WriteTimeout      time.Duration
	Heartbeat         time.Duration
	AdmissionRate     float64
	TrustForwardedFor bool
}

const AdmissionBurstFactor = 2

func DefaultConfig() Config {
	return Config{
		Addr:              "127.0.0.1:8080",
		MaxMessageBytes:   1 << 20,
		MaxQueueBytes:     4 << 20,
		MaxQueueMessages:  256,
		MaxClients:        1024,
		MaxHosts:          1024,
		MaxClientsPerHost: 128,
		MaxPendingPerHost: 32,
		AuthTimeout:       5 * time.Second,
		PairTimeout:       5 * time.Second,
		WriteTimeout:      5 * time.Second,
		Heartbeat:         15 * time.Second,
		AdmissionRate:     100,
	}
}

func ConfigFromEnv(lookup func(string) (string, bool)) (Config, error) {
	cfg := DefaultConfig()
	var err error
	str := func(name string, dst *string) {
		if v, ok := lookup(name); ok && err == nil {
			if v == "" {
				err = fmt.Errorf("%s must not be empty", name)
				return
			}
			*dst = v
		}
	}
	intv := func(name string, min int64, dst *int64) {
		if v, ok := lookup(name); ok && err == nil {
			n, perr := strconv.ParseInt(v, 10, 64)
			if perr != nil || n < min {
				err = fmt.Errorf("%s must be an integer >= %d, got %q", name, min, v)
				return
			}
			*dst = n
		}
	}
	intv32 := func(name string, min int64, dst *int) {
		var n int64 = int64(*dst)
		intv(name, min, &n)
		if n > int64(int(^uint(0)>>1)) {
			err = fmt.Errorf("%s is too large", name)
			return
		}
		*dst = int(n)
	}
	dur := func(name string, dst *time.Duration) {
		var ms int64 = dst.Milliseconds()
		intv(name, 1, &ms)
		*dst = time.Duration(ms) * time.Millisecond
	}
	str("RELAY_ADDR", &cfg.Addr)
	intv("RELAY_MAX_MESSAGE_BYTES", 1, &cfg.MaxMessageBytes)
	intv("RELAY_MAX_QUEUE_BYTES", 1, &cfg.MaxQueueBytes)
	intv32("RELAY_MAX_QUEUE_MESSAGES", 1, &cfg.MaxQueueMessages)
	intv32("RELAY_MAX_CLIENTS", 1, &cfg.MaxClients)
	intv32("RELAY_MAX_HOSTS", 1, &cfg.MaxHosts)
	intv32("RELAY_MAX_CLIENTS_PER_HOST", 1, &cfg.MaxClientsPerHost)
	intv32("RELAY_MAX_PENDING_PER_HOST", 1, &cfg.MaxPendingPerHost)
	dur("RELAY_AUTH_TIMEOUT_MS", &cfg.AuthTimeout)
	dur("RELAY_PAIR_TIMEOUT_MS", &cfg.PairTimeout)
	dur("RELAY_WRITE_TIMEOUT_MS", &cfg.WriteTimeout)
	dur("RELAY_HEARTBEAT_MS", &cfg.Heartbeat)
	if v, ok := lookup("RELAY_ADMISSION_RATE"); ok && err == nil {
		f, perr := strconv.ParseFloat(v, 64)
		if perr != nil || f <= 0 || f > 1e6 {
			err = fmt.Errorf("RELAY_ADMISSION_RATE must be a number in (0, 1000000], got %q", v)
		} else {
			cfg.AdmissionRate = f
		}
	}
	if v, ok := lookup("RELAY_TRUST_FORWARDED_FOR"); ok && err == nil {
		b, perr := strconv.ParseBool(v)
		if perr != nil {
			err = fmt.Errorf("RELAY_TRUST_FORWARDED_FOR must be a boolean, got %q", v)
		} else {
			cfg.TrustForwardedFor = b
		}
	}
	if err != nil {
		return cfg, err
	}
	if cfg.MaxQueueBytes < cfg.MaxMessageBytes {
		return cfg, fmt.Errorf("RELAY_MAX_QUEUE_BYTES (%d) must be >= RELAY_MAX_MESSAGE_BYTES (%d)", cfg.MaxQueueBytes, cfg.MaxMessageBytes)
	}
	if cfg.MaxPendingPerHost > cfg.MaxClientsPerHost {
		return cfg, fmt.Errorf("RELAY_MAX_PENDING_PER_HOST (%d) must be <= RELAY_MAX_CLIENTS_PER_HOST (%d)", cfg.MaxPendingPerHost, cfg.MaxClientsPerHost)
	}
	return cfg, nil
}

func ConfigFromOSEnv() (Config, error) {
	return ConfigFromEnv(os.LookupEnv)
}
