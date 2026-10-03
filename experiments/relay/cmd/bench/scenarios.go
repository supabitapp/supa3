package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"passio/relay/internal/fixture"
)

func relayMetrics(p *fixture.Process) (map[string]uint64, error) {
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get("http://" + p.Address + "/metrics")
	if err != nil {
		return nil, errors.New("metrics request failed")
	}
	defer response.Body.Close()
	var metrics map[string]uint64
	err = json.NewDecoder(response.Body).Decode(&metrics)
	return metrics, err
}

func idle(p *fixture.Process) ([]resource, error) {
	samples := make([]resource, 0, 6)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for i := 0; i < 6; i++ {
		r, err := readResource(p.Cmd.Process.Pid)
		if err != nil {
			return nil, err
		}
		samples = append(samples, r)
		if i < 5 {
			<-ticker.C
		}
	}
	return samples, nil
}

func memoryAndChurn(ctx context.Context, opt options) error {
	p, err := fixture.Start(opt.binary, benchEnv())
	if err != nil {
		return err
	}
	defer p.Stop()
	for _, count := range []int{0, 100, 500} {
		set, err := newPeers(ctx, p, "relay", count, false)
		if err != nil {
			return err
		}
		samples, err := idle(p)
		if err != nil {
			set.close()
			return err
		}
		metrics, err := relayMetrics(p)
		if err != nil {
			set.close()
			return err
		}
		if metrics["activePairs"] != uint64(count) {
			set.close()
			return errors.New("idle pair count mismatch")
		}
		hosts := len(set.hosts)
		before := time.Now()
		if err := set.close(); err != nil {
			return err
		}
		cleanup := time.Since(before).Seconds()
		after, err := idle(p)
		if err != nil {
			return err
		}
		cleaned, err := relayMetrics(p)
		if err != nil {
			return err
		}
		if cleaned["activePairs"] != 0 || cleaned["pendingPairs"] != 0 || cleaned["activeHosts"] != 0 {
			return errors.New("cleanup left live relay state")
		}
		value := map[string]interface{}{"event": "idle_memory", "pairedClients": count, "hosts": hosts, "resources": samples, "metrics": metrics, "cleanupSeconds": cleanup, "afterCleanupResources": after, "afterCleanupMetrics": cleaned}
		if err := emit(opt.output, fmtName("idle", count), value); err != nil {
			return err
		}
	}
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	first, err := readResource(p.Cmd.Process.Pid)
	if err != nil {
		return err
	}
	started := time.Now()
	var establishments []float64
	echoes := 0
	for cycle := 0; cycle < 5; cycle++ {
		h, err := fixture.Register(p.Address, key)
		if err != nil {
			return err
		}
		set := &peers{hosts: []*fixture.Host{h}, counts: []int{0}}
		for i := 0; i < 40; i++ {
			before := time.Now()
			pairCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			c, a, err := h.Pair(pairCtx)
			cancel()
			if err != nil {
				set.close()
				return err
			}
			set.clients = append(set.clients, c)
			set.accepted = append(set.accepted, a)
			set.counts[0]++
			go fixture.Echo(a)
			if err := c.WriteMessage(2, []byte("churn")); err != nil {
				set.close()
				return err
			}
			k, b, err := c.ReadMessage()
			if err != nil || k != 2 || string(b) != "churn" {
				set.close()
				return errors.New("churn echo failed")
			}
			echoes++
			establishments = append(establishments, float64(time.Since(before).Nanoseconds())/1000)
		}
		if err := set.close(); err != nil {
			return err
		}
	}
	last, err := readResource(p.Cmd.Process.Pid)
	if err != nil {
		return err
	}
	elapsed := time.Since(started).Seconds()
	cleaned, err := relayMetrics(p)
	if err != nil {
		return err
	}
	if cleaned["activeHosts"] != 0 || cleaned["activePairs"] != 0 || cleaned["pendingPairs"] != 0 {
		return errors.New("churn leaked live state")
	}
	return emit(opt.output, "churn", map[string]interface{}{"event": "reconnect_churn", "cycles": 5, "pairsPerCycle": 40, "samples": echoes, "durationSeconds": elapsed, "connectionsPerSecond": float64(echoes) / elapsed, "establishmentMicroseconds": percentiles(establishments), "rawEstablishmentMicroseconds": establishments, "cpuPercent": (last.CPUSeconds - first.CPUSeconds) / elapsed * 100, "before": first, "after": last, "metrics": cleaned, "failures": 0, "timeouts": 0, "corruption": 0})
}

func fmtName(prefix string, n int) string {
	return prefix + "-" + strconv.Itoa(n)
}

func slowIsolation(ctx context.Context, opt options) error {
	env := benchEnv()
	env["RELAY_WRITE_TIMEOUT_MS"] = "250"
	env["RELAY_MAX_QUEUE_BYTES"] = "262144"
	env["RELAY_MAX_QUEUE_MESSAGES"] = "8"
	p, err := fixture.Start(opt.binary, env)
	if err != nil {
		return err
	}
	defer p.Stop()
	healthy, err := newPeers(ctx, p, "relay", 1, true)
	if err != nil {
		return err
	}
	defer healthy.close()
	before, err := measure(p, healthy.clients, 1024, opt.duration, nil)
	if err != nil {
		return err
	}
	h, err := fixture.Register(p.Address, nil)
	if err != nil {
		return err
	}
	defer h.Control.Close()
	pairCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	c, a, err := h.Pair(pairCtx)
	cancel()
	if err != nil {
		return err
	}
	defer c.Close()
	defer a.Close()
	if tcp, ok := a.UnderlyingConn().(*net.TCPConn); ok {
		tcp.SetReadBuffer(1024)
	}

	sent := make(chan int, 1)
	released := make(chan float64, 1)
	failure := make(chan error, 1)
	var begin sync.Once
	var flooding, finished atomic.Bool
	var overlapping atomic.Int64
	observe := func() {
		begin.Do(func() {
			started := time.Now()
			go func() {
				closeCtx, closeCancel := context.WithTimeout(ctx, 5*time.Second)
				defer closeCancel()
				_, err := h.Next(closeCtx, "closed")
				finished.Store(true)
				if err != nil {
					failure <- err
					return
				}
				released <- time.Since(started).Seconds()
			}()
			go func() {
				c.SetWriteDeadline(time.Now().Add(3 * time.Second))
				body := make([]byte, 65536)
				count := 0
				flooding.Store(true)
				for count < 2048 {
					if c.WriteMessage(2, body) != nil {
						break
					}
					count++
				}
				sent <- count
			}()
		})
		if flooding.Load() && !finished.Load() {
			overlapping.Add(1)
		}
	}
	during, err := measure(p, healthy.clients, 1024, opt.duration, observe)
	if err != nil {
		return err
	}
	var closedAfter float64
	select {
	case closedAfter = <-released:
	case err := <-failure:
		return err
	case <-time.After(6 * time.Second):
		return errors.New("stalled pair cleanup timeout")
	}
	if overlapping.Load() == 0 {
		return errors.New("no healthy samples overlapped the stalled pair")
	}
	c.Close()
	var sentCount int
	select {
	case sentCount = <-sent:
	case <-time.After(4 * time.Second):
		return errors.New("slow sender did not stop")
	}
	path := filepath.Join(opt.output, "slow-isolation-samples.json")
	raw, _ := json.Marshal(map[string]interface{}{"beforeRTTMicroseconds": before.raw, "duringRTTMicroseconds": during.raw})
	if err := os.WriteFile(path, raw, 0600); err != nil {
		return err
	}
	before.raw = nil
	during.raw = nil
	before.Name = "healthy-before-stall"
	during.Name = "healthy-during-stall"
	for _, r := range []*result{&before, &during} {
		r.Mode = "relay"
		r.Clients = 1
		r.PayloadBytes = 1024
		r.Repetition = 1
		r.InFlight = 1
		r.RawPath = path
	}
	if before.Failures+before.Corruption+during.Failures+during.Corruption > 0 {
		return errors.New("slow reader affected healthy pair")
	}
	return emit(opt.output, "slow-isolation", map[string]interface{}{"event": "slow_reader_isolation", "healthyBefore": before, "healthyDuring": during, "healthySamplesWhileStalled": overlapping.Load(), "stalledAttemptedMessages": sentCount, "stalledPayloadBytes": 65536, "stalledClosedObservedSeconds": closedAfter, "rawSamples": path, "limits": env})
}
