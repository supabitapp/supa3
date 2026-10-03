package relay_test

import (
	"testing"

	"passio-relay/internal/relay"
)

func TestConfigFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) (string, bool) {
		return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
	}
	cfg, err := relay.ConfigFromEnv(env(map[string]string{}))
	if err != nil || cfg != relay.DefaultConfig() {
		t.Fatalf("defaults: %+v %v", cfg, err)
	}
	cfg, err = relay.ConfigFromEnv(env(map[string]string{
		"RELAY_ADDR": "127.0.0.1:0", "RELAY_MAX_MESSAGE_BYTES": "2048", "RELAY_MAX_QUEUE_BYTES": "4096",
		"RELAY_HEARTBEAT_MS": "250", "RELAY_ADMISSION_RATE": "5.5", "RELAY_TRUST_FORWARDED_FOR": "true",
	}))
	if err != nil || cfg.MaxMessageBytes != 2048 || cfg.Heartbeat.Milliseconds() != 250 || cfg.AdmissionRate != 5.5 || !cfg.TrustForwardedFor {
		t.Fatalf("parsed: %+v %v", cfg, err)
	}
	for name, bad := range map[string]map[string]string{
		"non-numeric":           {"RELAY_MAX_CLIENTS": "many"},
		"zero":                  {"RELAY_PAIR_TIMEOUT_MS": "0"},
		"negative":              {"RELAY_MAX_QUEUE_MESSAGES": "-1"},
		"queue below message":   {"RELAY_MAX_QUEUE_BYTES": "10"},
		"pending above clients": {"RELAY_MAX_PENDING_PER_HOST": "1000"},
		"rate zero":             {"RELAY_ADMISSION_RATE": "0"},
		"empty addr":            {"RELAY_ADDR": ""},
		"bad bool":              {"RELAY_TRUST_FORWARDED_FOR": "yes please"},
	} {
		if _, err := relay.ConfigFromEnv(env(bad)); err == nil {
			t.Fatalf("%s: expected error", name)
		}
	}
}
