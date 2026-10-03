package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/url"
	"sort"
	"sync"
	"time"

	"passio/relay/internal/fixture"

	"github.com/gorilla/websocket"
)

type quantiles struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
}

type result struct {
	Name                 string     `json:"name"`
	Mode                 string     `json:"mode"`
	Clients              int        `json:"clients"`
	PayloadBytes         int        `json:"payloadBytes"`
	Repetition           int        `json:"repetition"`
	InFlight             int        `json:"inFlightPerClient"`
	Samples              int        `json:"samples"`
	Duration             float64    `json:"durationSeconds"`
	WarmupSeconds        float64    `json:"warmupSeconds"`
	WarmupExchanges      int        `json:"warmupExchanges"`
	RTT                  quantiles  `json:"rttMicroseconds"`
	ExchangesPerSecond   float64    `json:"exchangesPerSecond"`
	PayloadMiBPerSecond  float64    `json:"payloadMiBPerSecond"`
	Establishment        quantiles  `json:"establishmentMicroseconds"`
	EstablishmentSamples int        `json:"establishmentSamples"`
	Failures             int        `json:"failures"`
	Timeouts             int        `json:"timeouts"`
	Corruption           int        `json:"corruption"`
	CPUPercent           float64    `json:"targetCPUPercent"`
	RSSKiB               int64      `json:"targetPeakRSSKiB"`
	Resources            []resource `json:"resourceSamples"`
	RawPath              string     `json:"rawSamples"`
	raw                  []float64
}

func percentiles(values []float64) quantiles {
	if len(values) == 0 {
		return quantiles{}
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	at := func(p float64) float64 { return sorted[min(len(sorted)-1, int(float64(len(sorted)-1)*p))] }
	return quantiles{at(.5), at(.95), at(.99)}
}

type peers struct {
	clients       []*websocket.Conn
	accepted      []*websocket.Conn
	hosts         []*fixture.Host
	counts        []int
	establishment []float64
}

func startEcho(binary string) (*fixture.Process, error) {
	return fixture.StartArgs(binary, nil, "-echo")
}

func newPeers(ctx context.Context, p *fixture.Process, mode string, count int, echo bool) (*peers, error) {
	set := &peers{}
	for i := 0; i < count; i++ {
		if err := ctx.Err(); err != nil {
			set.close()
			return nil, err
		}
		if mode == "relay" && i%128 == 0 {
			h, err := fixture.Register(p.Address, nil)
			if err != nil {
				set.close()
				return nil, err
			}
			set.hosts = append(set.hosts, h)
			set.counts = append(set.counts, 0)
		}
		started := time.Now()
		var c, a *websocket.Conn
		var err error
		if mode == "direct" {
			c, _, err = fixture.Dial(p.Address, "/", url.Values{})
		} else {
			pairCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			c, a, err = set.hosts[len(set.hosts)-1].Pair(pairCtx)
			cancel()
		}
		if err != nil {
			set.close()
			return nil, err
		}
		set.clients = append(set.clients, c)
		if a != nil {
			set.accepted = append(set.accepted, a)
			set.counts[len(set.counts)-1]++
		}
		if echo {
			if a != nil {
				go fixture.Echo(a)
			}
			if err = c.WriteMessage(2, []byte("ready")); err == nil {
				var k int
				var b []byte
				k, b, err = c.ReadMessage()
				if err == nil && (k != 2 || string(b) != "ready") {
					err = errors.New("readiness echo corrupted")
				}
			}
			if err != nil {
				set.close()
				return nil, err
			}
		} else {
			if err = c.WriteMessage(2, []byte("ready")); err == nil {
				_, b, e := a.ReadMessage()
				err = e
				if e == nil && string(b) != "ready" {
					err = errors.New("readiness corrupted")
				}
			}
			if err != nil {
				set.close()
				return nil, err
			}
		}
		set.establishment = append(set.establishment, float64(time.Since(started).Nanoseconds())/1000)
	}
	return set, nil
}

func (p *peers) close() error {
	for _, c := range p.clients {
		c.Close()
	}
	for _, c := range p.accepted {
		c.Close()
	}
	var first error
	for i, h := range p.hosts {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		for j := 0; j < p.counts[i]; j++ {
			if _, err := h.Next(ctx, "closed"); err != nil {
				if first == nil {
					first = err
				}
				break
			}
		}
		cancel()
		h.Control.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(1000, "done"), time.Now().Add(time.Second))
		select {
		case <-h.Done:
		case <-time.After(2 * time.Second):
			if first == nil {
				first = errors.New("host cleanup timeout")
			}
		}
		h.Control.Close()
	}
	p.clients = nil
	p.accepted = nil
	p.hosts = nil
	return first
}

func workload(clients []*websocket.Conn, size int, duration time.Duration, collect bool, onSample func()) (result, error) {
	var aggregate result
	ready := make(chan struct{})
	outcomes := make(chan result, len(clients))
	var wg sync.WaitGroup
	started := time.Now()
	end := started.Add(duration)
	for i, c := range clients {
		wg.Add(1)
		go func() {
			defer wg.Done()
			local := result{}
			payload := bytes.Repeat([]byte{byte(i + 1)}, size)
			binary.LittleEndian.PutUint64(payload, uint64(i))
			<-ready
			for sequence := uint64(0); time.Now().Before(end); sequence++ {
				binary.LittleEndian.PutUint64(payload[8:], sequence)
				c.SetReadDeadline(time.Now().Add(3 * time.Second))
				c.SetWriteDeadline(time.Now().Add(3 * time.Second))
				before := time.Now()
				err := c.WriteMessage(websocket.BinaryMessage, payload)
				var kind int
				var body []byte
				if err == nil {
					kind, body, err = c.ReadMessage()
				}
				elapsed := float64(time.Since(before).Nanoseconds()) / 1000
				if err != nil {
					local.Failures++
					var ne net.Error
					if errors.As(err, &ne) && ne.Timeout() {
						local.Timeouts++
					}
					break
				}
				if kind != 2 || !bytes.Equal(body, payload) {
					local.Corruption++
					break
				}
				local.Samples++
				if onSample != nil {
					onSample()
				}
				if collect {
					local.raw = append(local.raw, elapsed)
				}
			}
			outcomes <- local
		}()
	}
	close(ready)
	wg.Wait()
	close(outcomes)
	aggregate.Duration = time.Since(started).Seconds()
	for local := range outcomes {
		aggregate.Samples += local.Samples
		aggregate.Failures += local.Failures
		aggregate.Timeouts += local.Timeouts
		aggregate.Corruption += local.Corruption
		aggregate.raw = append(aggregate.raw, local.raw...)
	}
	aggregate.RTT = percentiles(aggregate.raw)
	aggregate.ExchangesPerSecond = float64(aggregate.Samples) / aggregate.Duration
	aggregate.PayloadMiBPerSecond = float64(aggregate.Samples) * float64(size) * 2 / aggregate.Duration / 1048576
	if !collect && (aggregate.Failures > 0 || aggregate.Corruption > 0) {
		return aggregate, errors.New("warmup workload failed")
	}
	return aggregate, nil
}

func measure(p *fixture.Process, clients []*websocket.Conn, size int, duration time.Duration, onSample func()) (result, error) {
	first, err := readResource(p.Cmd.Process.Pid)
	if err != nil {
		return result{}, err
	}
	stop := make(chan struct{})
	samples := make(chan []resource, 1)
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		values := []resource{first}
		for {
			select {
			case <-stop:
				samples <- values
				return
			case <-ticker.C:
				if v, err := readResource(p.Cmd.Process.Pid); err == nil {
					values = append(values, v)
				}
			}
		}
	}()
	r, err := workload(clients, size, duration, true, onSample)
	close(stop)
	r.Resources = <-samples
	last, sampleErr := readResource(p.Cmd.Process.Pid)
	if sampleErr != nil {
		return r, sampleErr
	}
	r.Resources = append(r.Resources, last)
	r.CPUPercent = (last.CPUSeconds - first.CPUSeconds) / r.Duration * 100
	for _, v := range r.Resources {
		r.RSSKiB = max(r.RSSKiB, v.RSSKiB)
	}
	return r, err
}
