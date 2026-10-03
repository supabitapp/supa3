package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
)

type options struct {
	relayBinary string
	outDir      string
	warmup      time.Duration
	duration    time.Duration
	reps        int
	inflight    int
	quick       bool
	only        string
}

type caseResult struct {
	Name           string         `json:"name"`
	Mode           string         `json:"mode"`
	PayloadBytes   int            `json:"payloadBytes"`
	Clients        int            `json:"clients"`
	Inflight       int            `json:"inflightPerClient"`
	Repetition     int            `json:"repetition"`
	WarmupMs       int64          `json:"warmupMs"`
	DurationMs     int64          `json:"measuredDurationMs"`
	Samples        int            `json:"samples"`
	RTTp50Us       float64        `json:"rttP50Us"`
	RTTp95Us       float64        `json:"rttP95Us"`
	RTTp99Us       float64        `json:"rttP99Us"`
	RTTMaxUs       float64        `json:"rttMaxUs"`
	MessagesPerSec float64        `json:"messagesPerSec"`
	PayloadMiBps   float64        `json:"payloadMiBPerSec"`
	ConnectP50Us   float64        `json:"connectP50Us"`
	ConnectP99Us   float64        `json:"connectP99Us"`
	Failures       int64          `json:"failures"`
	Timeouts       int64          `json:"timeouts"`
	Corruptions    int64          `json:"corruptions"`
	RelayCPUPct    float64        `json:"relayCpuPercent"`
	RelayRSSMiB    float64        `json:"relayRssMiB"`
	Extra          map[string]any `json:"extra,omitempty"`
}

type report struct {
	Platform   map[string]any `json:"platform"`
	Config     map[string]any `json:"config"`
	Cases      []caseResult   `json:"cases"`
	Memory     []memoryPoint  `json:"memory"`
	SlowReader map[string]any `json:"slowReaderIsolation"`
	RawDir     string         `json:"rawDir"`
	StartedAt  string         `json:"startedAt"`
	FinishedAt string         `json:"finishedAt"`
}

type memoryPoint struct {
	Stage      string  `json:"stage"`
	Pairs      int     `json:"pairs"`
	RSSMiB     float64 `json:"relayRssMiB"`
	ElapsedMs  int64   `json:"elapsedMs"`
	Failures   int64   `json:"failures"`
	ActivePair int64   `json:"metricsActivePairs"`
}

func main() {
	var o options
	flag.StringVar(&o.relayBinary, "relay", "", "path to the built relay binary")
	flag.StringVar(&o.outDir, "out", "", "directory for raw outputs")
	flag.DurationVar(&o.warmup, "warmup", 2*time.Second, "warmup per case")
	flag.DurationVar(&o.duration, "duration", 5*time.Second, "measured duration per case")
	flag.IntVar(&o.reps, "reps", 3, "repetitions of the main 1 KiB / 32 client case")
	flag.IntVar(&o.inflight, "inflight", 1, "messages in flight per client")
	flag.BoolVar(&o.quick, "quick", false, "short smoke run")
	flag.StringVar(&o.only, "only", "", "comma-separated subset: relay,direct,pipelined,memory,slow")
	flag.Parse()
	if o.relayBinary == "" || o.outDir == "" {
		fmt.Fprintln(os.Stderr, "-relay and -out are required")
		os.Exit(2)
	}
	if o.quick {
		o.warmup, o.duration, o.reps = 300*time.Millisecond, 700*time.Millisecond, 1
	}
	if err := os.MkdirAll(o.outDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	rep, err := run(o)
	if err != nil {
		fmt.Fprintln(os.Stderr, "benchmark failed:", err)
		os.Exit(1)
	}
	out, _ := json.MarshalIndent(rep, "", "  ")
	os.WriteFile(filepath.Join(o.outDir, "report.json"), out, 0o644)
	fmt.Println(string(out))
}

func (o options) wants(section string) bool {
	if o.only == "" {
		return true
	}
	for _, s := range strings.Split(o.only, ",") {
		if strings.TrimSpace(s) == section {
			return true
		}
	}
	return false
}

func run(o options) (*report, error) {
	rep := &report{
		Platform: map[string]any{
			"os": runtime.GOOS, "arch": runtime.GOARCH, "goVersion": runtime.Version(),
			"cpus": runtime.NumCPU(), "cpuBrand": sysctl("machdep.cpu.brand_string"), "memoryBytes": sysctl("hw.memsize"),
			"websocketLibrary": "github.com/gorilla/websocket v1.5.3", "buildMode": "release (-trimpath -ldflags=-s -w)",
		},
		Config: map[string]any{
			"warmupMs": o.warmup.Milliseconds(), "measuredDurationMs": o.duration.Milliseconds(),
			"inflightPerClient": o.inflight, "repetitionsMainCase": o.reps, "quick": o.quick,
		},
		RawDir:    o.outDir,
		StartedAt: time.Now().Format(time.RFC3339),
	}
	payloads := []int{64, 1024, 64 * 1024}
	clientCounts := []int{1, 32, 128}
	if o.quick {
		payloads = []int{64, 1024}
		clientCounts = []int{1, 32}
	}

	relay, err := spawnRelay(o, map[string]string{
		"RELAY_MAX_CLIENTS": "2048", "RELAY_MAX_CLIENTS_PER_HOST": "256", "RELAY_MAX_PENDING_PER_HOST": "256",
		"RELAY_ADMISSION_RATE": "100000",
	})
	if err != nil {
		return nil, err
	}
	defer relay.stop()

	baseline, err := startBaselineEcho()
	if err != nil {
		return nil, err
	}
	defer baseline.Close()

	for _, payload := range payloads {
		for _, clients := range clientCounts {
			if !o.wants("relay") {
				break
			}
			reps := 1
			if payload == 1024 && clients == 32 {
				reps = o.reps
			}
			for i := 1; i <= reps; i++ {
				res, err := echoCase(o, relay, "relay", payload, clients, i)
				if err != nil {
					return nil, err
				}
				rep.Cases = append(rep.Cases, res)
				fmt.Fprintf(os.Stderr, "%s\n", summarize(res))
			}
		}
	}
	for _, payload := range payloads {
		for _, clients := range clientCounts {
			if !o.wants("direct") {
				break
			}
			res, err := echoCaseDirect(o, baseline, payload, clients, relay)
			if err != nil {
				return nil, err
			}
			rep.Cases = append(rep.Cases, res)
			fmt.Fprintf(os.Stderr, "%s\n", summarize(res))
		}
	}
	if !o.quick && o.wants("pipelined") {
		res, err := echoCaseInflight(o, relay, 1024, 32, 8)
		if err != nil {
			return nil, err
		}
		rep.Cases = append(rep.Cases, res)
		fmt.Fprintf(os.Stderr, "%s\n", summarize(res))
	}

	if o.wants("memory") {
		mem, err := memoryCases(o, relay)
		if err != nil {
			return nil, err
		}
		rep.Memory = mem
	}
	if o.wants("slow") {
		slow, err := slowReaderCase(o, relay)
		if err != nil {
			return nil, err
		}
		rep.SlowReader = slow
	}
	rep.FinishedAt = time.Now().Format(time.RFC3339)
	return rep, nil
}

func summarize(r caseResult) string {
	return fmt.Sprintf("%-22s payload=%6d clients=%3d rep=%d p50=%.0fus p99=%.0fus msg/s=%.0f MiB/s=%.2f cpu=%.0f%% rss=%.1fMiB fail=%d",
		r.Name, r.PayloadBytes, r.Clients, r.Repetition, r.RTTp50Us, r.RTTp99Us, r.MessagesPerSec, r.PayloadMiBps, r.RelayCPUPct, r.RelayRSSMiB, r.Failures)
}

type relayProc struct {
	cmd  *exec.Cmd
	pid  int
	WS   string
	HTTP string
	done chan error
}

func spawnRelay(o options, env map[string]string) (*relayProc, error) {
	cmd := exec.Command(o.relayBinary)
	cmd.Env = append(os.Environ(), "RELAY_ADDR=127.0.0.1:0")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	stderr, err := os.Create(filepath.Join(o.outDir, "relay-stderr.log"))
	if err != nil {
		return nil, err
	}
	cmd.Stderr = stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var line struct {
		Address string `json:"address"`
	}
	raw, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || json.Unmarshal([]byte(raw), &line) != nil {
		cmd.Process.Kill()
		return nil, fmt.Errorf("relay startup line %q: %v", raw, err)
	}
	p := &relayProc{cmd: cmd, pid: cmd.Process.Pid, WS: "ws://" + line.Address, HTTP: "http://" + line.Address, done: make(chan error, 1)}
	go func() { p.done <- cmd.Wait() }()
	return p, nil
}

func (p *relayProc) stop() {
	p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
		p.cmd.Process.Kill()
		<-p.done
	}
}

type procSample struct {
	cpu time.Duration
	rss float64
	at  time.Time
}

func sampleProc(pid int) procSample {
	out, err := exec.Command("ps", "-o", "cputime=,rss=", "-p", strconv.Itoa(pid)).Output()
	s := procSample{at: time.Now()}
	if err != nil {
		return s
	}
	fields := strings.Fields(string(out))
	if len(fields) != 2 {
		return s
	}
	s.cpu = parseCPUTime(fields[0])
	kb, _ := strconv.ParseFloat(fields[1], 64)
	s.rss = kb / 1024
	return s
}

func parseCPUTime(s string) time.Duration {
	var total float64
	parts := strings.Split(s, ":")
	for _, p := range parts {
		v, _ := strconv.ParseFloat(p, 64)
		total = total*60 + v
	}
	return time.Duration(total * float64(time.Second))
}

func cpuPercent(a, b procSample) float64 {
	wall := b.at.Sub(a.at).Seconds()
	if wall <= 0 {
		return 0
	}
	return (b.cpu - a.cpu).Seconds() / wall * 100
}

func metricsOf(url string) (map[string]any, error) {
	resp, err := http.Get(url + "/metrics")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var m map[string]any
	return m, json.NewDecoder(resp.Body).Decode(&m)
}

type pairedSet struct {
	clients  []*websocket.Conn
	hosts    []*endpoint.Host
	connects []time.Duration
	failures int64
	cancel   context.CancelFunc
}

func (s *pairedSet) close() {
	for _, c := range s.clients {
		endpoint.CloseWith(c, websocket.CloseNormalClosure, "")
		c.Close()
	}
	for _, h := range s.hosts {
		h.Close()
	}
	s.cancel()
}

func pairClients(relay *relayProc, count, perHost int) (*pairedSet, error) {
	ctx, cancel := context.WithCancel(context.Background())
	set := &pairedSet{cancel: cancel}
	hostCount := (count + perHost - 1) / perHost
	if hostCount == 0 {
		hostCount = 1
	}
	for i := 0; i < hostCount; i++ {
		h, err := endpoint.Register(ctx, relay.WS, endpoint.NewIdentity())
		if err != nil {
			set.close()
			return nil, fmt.Errorf("register host %d: %w", i, err)
		}
		set.hosts = append(set.hosts, h)
		go h.ServeEcho(ctx)
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 32)
	for i := 0; i < count; i++ {
		h := set.hosts[i%hostCount]
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			start := time.Now()
			c, err := connectAndVerify(ctx, relay.WS, h.Identity.EndpointID)
			elapsed := time.Since(start)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				set.failures++
				return
			}
			set.clients = append(set.clients, c)
			set.connects = append(set.connects, elapsed)
		}()
	}
	wg.Wait()
	return set, nil
}

func connectAndVerify(ctx context.Context, ws, endpointID string) (*websocket.Conn, error) {
	c, _, err := endpoint.Connect(ctx, ws, endpointID)
	if err != nil {
		return nil, err
	}
	probe := []byte("probe")
	c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := c.WriteMessage(websocket.BinaryMessage, probe); err != nil {
		c.Close()
		return nil, err
	}
	c.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil || string(data) != "probe" {
		c.Close()
		return nil, fmt.Errorf("probe failed: %v", err)
	}
	return c, nil
}

type loadStats struct {
	samples     []time.Duration
	messages    int64
	bytes       int64
	failures    int64
	timeouts    int64
	corruptions int64
}

func runEchoLoad(conns []*websocket.Conn, payload, inflight int, warmup, duration time.Duration) loadStats {
	var mu sync.Mutex
	var stats loadStats
	var measuring atomic.Bool
	var stop atomic.Bool
	var wg sync.WaitGroup
	for ci, c := range conns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var local []time.Duration
			var msgs, bytes, failures, timeouts, corruptions int64
			buf := make([]byte, payload)
			for i := range buf {
				buf[i] = byte(ci + i)
			}
			sent := make([]time.Time, 0, inflight)
			seq := 0
			for !stop.Load() {
				for len(sent) < inflight {
					if payload >= 4 {
						buf[0], buf[1], buf[2], buf[3] = byte(seq>>24), byte(seq>>16), byte(seq>>8), byte(seq)
					}
					c.SetWriteDeadline(time.Now().Add(10 * time.Second))
					if err := c.WriteMessage(websocket.BinaryMessage, buf); err != nil {
						failures++
						stop.Store(true)
						break
					}
					sent = append(sent, time.Now())
					seq++
				}
				if len(sent) == 0 {
					break
				}
				c.SetReadDeadline(time.Now().Add(10 * time.Second))
				_, data, err := c.ReadMessage()
				if err != nil {
					var ne net.Error
					if errors.As(err, &ne) && ne.Timeout() {
						timeouts++
					} else {
						failures++
					}
					break
				}
				rtt := time.Since(sent[0])
				sent = sent[1:]
				if len(data) != payload {
					corruptions++
				} else if payload >= 4 {
					want := seq - len(sent) - 1
					got := int(data[0])<<24 | int(data[1])<<16 | int(data[2])<<8 | int(data[3])
					if got != want {
						corruptions++
					}
				}
				if measuring.Load() {
					local = append(local, rtt)
					msgs++
					bytes += int64(payload)
				}
			}
			mu.Lock()
			stats.samples = append(stats.samples, local...)
			stats.messages += msgs
			stats.bytes += bytes
			stats.failures += failures
			stats.timeouts += timeouts
			stats.corruptions += corruptions
			mu.Unlock()
		}()
	}
	time.Sleep(warmup)
	measuring.Store(true)
	time.Sleep(duration)
	measuring.Store(false)
	stop.Store(true)
	wg.Wait()
	return stats
}

func percentile(samples []time.Duration, p float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	idx := int(float64(len(samples)-1) * p)
	return float64(samples[idx].Microseconds()) + float64(samples[idx].Nanoseconds()%1000)/1000
}

func finish(o options, name, mode string, payload, clients, inflight, rep int, connects []time.Duration, stats loadStats, before, after procSample, rawName string) caseResult {
	sort.Slice(stats.samples, func(i, j int) bool { return stats.samples[i] < stats.samples[j] })
	sort.Slice(connects, func(i, j int) bool { return connects[i] < connects[j] })
	res := caseResult{
		Name: name, Mode: mode, PayloadBytes: payload, Clients: clients, Inflight: inflight, Repetition: rep,
		WarmupMs: o.warmup.Milliseconds(), DurationMs: o.duration.Milliseconds(), Samples: len(stats.samples),
		RTTp50Us: percentile(stats.samples, 0.50), RTTp95Us: percentile(stats.samples, 0.95), RTTp99Us: percentile(stats.samples, 0.99), RTTMaxUs: percentile(stats.samples, 1),
		MessagesPerSec: float64(stats.messages) / o.duration.Seconds(),
		PayloadMiBps:   float64(stats.bytes) / o.duration.Seconds() / (1 << 20),
		ConnectP50Us:   percentile(connects, 0.5), ConnectP99Us: percentile(connects, 0.99),
		Failures: stats.failures, Timeouts: stats.timeouts, Corruptions: stats.corruptions,
		RelayCPUPct: cpuPercent(before, after), RelayRSSMiB: after.rss,
	}
	raw := map[string]any{"case": res, "rttSamplesUs": toMicros(stats.samples), "connectSamplesUs": toMicros(connects)}
	b, _ := json.Marshal(raw)
	os.WriteFile(filepath.Join(o.outDir, rawName+".json"), b, 0o644)
	return res
}

func toMicros(d []time.Duration) []float64 {
	out := make([]float64, len(d))
	for i, v := range d {
		out[i] = float64(v.Nanoseconds()) / 1000
	}
	return out
}

func echoCase(o options, relay *relayProc, name string, payload, clients, rep int) (caseResult, error) {
	return echoCaseInflightRep(o, relay, name, payload, clients, o.inflight, rep)
}

func echoCaseInflight(o options, relay *relayProc, payload, clients, inflight int) (caseResult, error) {
	return echoCaseInflightRep(o, relay, "relay-pipelined", payload, clients, inflight, 1)
}

func echoCaseInflightRep(o options, relay *relayProc, name string, payload, clients, inflight, rep int) (caseResult, error) {
	set, err := pairClients(relay, clients, 128)
	if err != nil {
		return caseResult{}, err
	}
	defer set.close()
	if set.failures > 0 {
		return caseResult{}, fmt.Errorf("%d clients failed to pair", set.failures)
	}
	before := sampleProc(relay.pid)
	stats := runEchoLoad(set.clients, payload, inflight, o.warmup, o.duration)
	after := sampleProc(relay.pid)
	rawName := fmt.Sprintf("%s-%d-%d-inflight%d-rep%d", name, payload, clients, inflight, rep)
	res := finish(o, name, "relay", payload, clients, inflight, rep, set.connects, stats, before, after, rawName)
	if m, err := metricsOf(relay.HTTP); err == nil {
		res.Extra = map[string]any{"relayMetrics": m}
	}
	return res, nil
}

type baselineServer struct {
	ln  net.Listener
	srv *http.Server
	WS  string
}

func (b *baselineServer) Close() { b.srv.Close() }

func startBaselineEcho() (*baselineServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	up := websocket.Upgrader{}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		endpoint.Echo(c)
	})}
	go srv.Serve(ln)
	return &baselineServer{ln: ln, srv: srv, WS: "ws://" + ln.Addr().String()}, nil
}

func echoCaseDirect(o options, b *baselineServer, payload, clients int, relay *relayProc) (caseResult, error) {
	var conns []*websocket.Conn
	var connects []time.Duration
	for i := 0; i < clients; i++ {
		start := time.Now()
		c, _, err := endpoint.Dialer.Dial(b.WS+"/echo", nil)
		if err != nil {
			return caseResult{}, err
		}
		connects = append(connects, time.Since(start))
		conns = append(conns, c)
	}
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	before := sampleProc(relay.pid)
	stats := runEchoLoad(conns, payload, o.inflight, o.warmup, o.duration)
	after := sampleProc(relay.pid)
	res := finish(o, "direct-baseline", "direct", payload, clients, o.inflight, 1, connects, stats, before, after, fmt.Sprintf("direct-%d-%d", payload, clients))
	res.RelayCPUPct, res.RelayRSSMiB = 0, 0
	return res, nil
}

func waitMetric(url, key string, want float64, timeout time.Duration) (float64, bool) {
	stop := time.Now().Add(timeout)
	for {
		m, err := metricsOf(url)
		if err == nil {
			if v, _ := m[key].(float64); v == want {
				return v, true
			} else if time.Now().After(stop) {
				return v, false
			}
		} else if time.Now().After(stop) {
			return -1, false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func memoryCases(o options, relay *relayProc) ([]memoryPoint, error) {
	var points []memoryPoint
	settle := func(stage string, pairs int, failures int64, started time.Time) {
		runtimeSettle(relay.HTTP)
		s := sampleProc(relay.pid)
		active, _ := waitMetric(relay.HTTP, "activePairs", float64(pairs), 10*time.Second)
		points = append(points, memoryPoint{Stage: stage, Pairs: pairs, RSSMiB: s.rss, ElapsedMs: time.Since(started).Milliseconds(), Failures: failures, ActivePair: int64(active)})
		fmt.Fprintf(os.Stderr, "memory %-28s pairs=%d rss=%.1fMiB elapsed=%dms failures=%d\n", stage, pairs, s.rss, time.Since(started).Milliseconds(), failures)
	}
	settle("idle-0", 0, 0, time.Now())
	sizes := []int{100, 500}
	if o.quick {
		sizes = []int{100}
	}
	for _, n := range sizes {
		start := time.Now()
		set, err := pairClients(relay, n, 100)
		if err != nil {
			return nil, err
		}
		if _, ok := waitMetric(relay.HTTP, "activePairs", float64(n-int(set.failures)), 10*time.Second); !ok {
			set.close()
			return nil, fmt.Errorf("pairs never settled for %d", n)
		}
		settle(fmt.Sprintf("idle-%d", n), n, set.failures, start)
		start = time.Now()
		set.close()
		if _, ok := waitMetric(relay.HTTP, "activePairs", 0, 15*time.Second); !ok {
			return nil, fmt.Errorf("pairs never released after %d", n)
		}
		settle(fmt.Sprintf("after-disconnect-%d", n), 0, set.failures, start)
	}

	churnTotal, churnConcurrency := 2000, 32
	if o.quick {
		churnTotal = 200
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h, err := endpoint.Register(ctx, relay.WS, endpoint.NewIdentity())
	if err != nil {
		return nil, err
	}
	go h.ServeEcho(ctx)
	start := time.Now()
	var wg sync.WaitGroup
	var failures atomic.Int64
	sem := make(chan struct{}, churnConcurrency)
	for i := 0; i < churnTotal; i++ {
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			c, err := connectAndVerify(ctx, relay.WS, h.Identity.EndpointID)
			if err != nil {
				failures.Add(1)
				return
			}
			endpoint.CloseWith(c, websocket.CloseNormalClosure, "")
			endpoint.ReadClose(c, 5*time.Second)
		}()
	}
	wg.Wait()
	churnElapsed := time.Since(start)
	if _, ok := waitMetric(relay.HTTP, "activePairs", 0, 15*time.Second); !ok {
		return nil, errors.New("pairs never released after churn")
	}
	h.Close()
	settle(fmt.Sprintf("after-churn-%d-conc%d", churnTotal, churnConcurrency), 0, failures.Load(), start)
	points[len(points)-1].ElapsedMs = churnElapsed.Milliseconds()
	return points, nil
}

func runtimeSettle(url string) {
	time.Sleep(500 * time.Millisecond)
	metricsOf(url)
}

func slowReaderCase(o options, relay *relayProc) (map[string]any, error) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stalledHost, err := endpoint.Register(ctx, relay.WS, endpoint.NewIdentity())
	if err != nil {
		return nil, err
	}
	defer stalledHost.Close()
	go func() {
		for {
			msg, err := stalledHost.WaitEvent(ctx, "incoming", "")
			if err != nil {
				return
			}
			c, _, err := stalledHost.Accept(ctx, msg.ConnectionID, msg.Token)
			if err != nil {
				return
			}
			<-ctx.Done()
			c.Close()
		}
	}()
	stalledClient, _, err := endpoint.Connect(ctx, relay.WS, stalledHost.Identity.EndpointID)
	if err != nil {
		return nil, err
	}
	defer stalledClient.Close()

	healthy, err := pairClients(relay, 1, 1)
	if err != nil {
		return nil, err
	}
	defer healthy.close()

	floodDone := make(chan map[string]any, 1)
	go func() {
		chunk := make([]byte, 64<<10)
		start := time.Now()
		var sent int64
		for {
			stalledClient.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := stalledClient.WriteMessage(websocket.BinaryMessage, chunk); err != nil {
				break
			}
			sent++
		}
		code, reason, _ := endpoint.ReadClose(stalledClient, 10*time.Second)
		floodDone <- map[string]any{"messagesSent": sent, "bytesSent": sent * (64 << 10), "closeCode": code, "closeReason": reason, "stalledForMs": time.Since(start).Milliseconds()}
	}()
	before := sampleProc(relay.pid)
	stats := runEchoLoad(healthy.clients, 1024, 1, o.warmup, o.duration)
	after := sampleProc(relay.pid)
	res := finish(o, "healthy-during-slow-reader", "relay", 1024, 1, 1, 1, healthy.connects, stats, before, after, "slow-reader-healthy")
	var flood map[string]any
	select {
	case flood = <-floodDone:
	case <-time.After(30 * time.Second):
		flood = map[string]any{"error": "stalled pair was not closed within 30s"}
	}
	return map[string]any{"healthyPair": res, "stalledPair": flood}, nil
}

func sysctl(key string) string {
	out, err := exec.Command("sysctl", "-n", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
