package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"syscall"
	"time"

	"passio/relay/internal/fixture"
)

type options struct {
	binary, output   string
	duration, warmup time.Duration
}

func main() {
	echo := flag.Bool("echo", false, "run an isolated direct echo baseline")
	binary := flag.String("relay", "bin/relay", "built relay executable")
	output := flag.String("output", "", "raw artifact directory outside the worktree")
	duration := flag.Duration("duration", time.Second, "measurement duration per workload")
	warmup := flag.Duration("warmup", 250*time.Millisecond, "warmup duration per workload")
	flag.Parse()
	if *echo {
		if err := echoServer(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *duration < 100*time.Millisecond || *duration > 10*time.Second || *warmup < 0 || *warmup > 5*time.Second {
		fmt.Fprintln(os.Stderr, "invalid bounded benchmark duration")
		os.Exit(1)
	}
	dir := *output
	if dir == "" {
		var err error
		dir, err = os.MkdirTemp("", "passio-relay-bench-")
		if err != nil {
			panic(err)
		}
	}
	dir, _ = filepath.Abs(dir)
	if err := os.MkdirAll(dir, 0700); err != nil {
		panic(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	if err := suite(ctx, options{*binary, dir, *duration, *warmup}); err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "error", "error": err.Error(), "artifacts": dir})
		os.Exit(1)
	}
}

func echoServer() error {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: http.HandlerFunc(fixture.EchoHandler), ReadHeaderTimeout: 5 * time.Second}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	defer signal.Stop(signals)
	go server.Serve(l)
	json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "listening", "address": l.Addr().String()})
	<-signals
	server.Close()
	return nil
}

func suite(ctx context.Context, opt options) error {
	info, _ := debug.ReadBuildInfo()
	executable, _ := os.Executable()
	hashes := map[string]string{}
	for name, path := range map[string]string{"relay": opt.binary, "driver": executable} {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		hashes[name] = hex.EncodeToString(sum[:])
	}
	metadata := map[string]interface{}{"event": "metadata", "binarySHA256": hashes, "platform": runtime.GOOS + "/" + runtime.GOARCH, "runtime": runtime.Version(), "logicalCPUs": runtime.NumCPU(), "gomaxprocs": runtime.GOMAXPROCS(0), "build": "go build -trimpath -ldflags='-s -w' (no race instrumentation)", "dependencies": info.Deps, "durationSeconds": opt.duration.Seconds(), "warmupSeconds": opt.warmup.Seconds(), "inFlightPerClient": 1, "mainRepetitions": 3, "artifacts": opt.output, "resourceSampling": "ps cumulative CPU time delta; RSS sampled every 100 ms; one core = 100%", "transport": "loopback WS, binary complete messages, compression disabled", "payloadMiBDefinition": "successful exchanges * payload bytes * 2 / seconds / 1048576", "provisional": true, "system": systemInfo(), "limits": benchEnv()}
	if err := emit(opt.output, "metadata", metadata); err != nil {
		return err
	}
	for _, mode := range []string{"direct", "relay"} {
		if err := matrix(ctx, opt, mode); err != nil {
			return err
		}
	}
	if err := memoryAndChurn(ctx, opt); err != nil {
		return err
	}
	if err := slowIsolation(ctx, opt); err != nil {
		return err
	}
	return emit(opt.output, "complete", map[string]interface{}{"event": "complete", "artifacts": opt.output})
}

func benchEnv() map[string]string {
	return map[string]string{"RELAY_MAX_CLIENTS": "768", "RELAY_MAX_CLIENTS_PER_HOST": "128", "RELAY_MAX_PENDING_PER_HOST": "128", "RELAY_ADMISSION_RATE": "100000"}
}

func emit(dir, name string, value interface{}) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, name+".json"), append(encoded, '\n'), 0600); err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func matrix(ctx context.Context, opt options, mode string) error {
	binary := opt.binary
	if mode == "direct" {
		var err error
		binary, err = os.Executable()
		if err != nil {
			return err
		}
	}
	var p *fixture.Process
	var err error
	if mode == "direct" {
		p, err = startEcho(binary)
	} else {
		p, err = fixture.Start(binary, benchEnv())
	}
	if err != nil {
		return err
	}
	defer p.Stop()
	for _, size := range []int{64, 1024, 65536} {
		for _, count := range []int{1, 32, 128} {
			repetitions := 1
			if size == 1024 && count == 32 {
				repetitions = 3
			}
			for rep := 1; rep <= repetitions; rep++ {
				if err := ctx.Err(); err != nil {
					return err
				}
				name := fmt.Sprintf("%s-%dB-%dclients-r%d", mode, size, count, rep)
				peers, err := newPeers(ctx, p, mode, count, true)
				if err != nil {
					return err
				}
				warmup, err := workload(peers.clients, size, opt.warmup, false, nil)
				if err != nil {
					peers.close()
					return err
				}
				result, err := measure(p, peers.clients, size, opt.duration, nil)
				if err != nil {
					peers.close()
					return err
				}
				result.Name = name
				result.Mode = mode
				result.Clients = count
				result.PayloadBytes = size
				result.Repetition = rep
				result.WarmupExchanges = warmup.Samples
				result.Establishment = percentiles(peers.establishment)
				result.EstablishmentSamples = len(peers.establishment)
				result.WarmupSeconds = opt.warmup.Seconds()
				result.InFlight = 1
				raw := map[string]interface{}{"rttMicroseconds": result.raw, "establishmentMicroseconds": peers.establishment}
				data, _ := json.Marshal(raw)
				rawPath := filepath.Join(opt.output, name+"-samples.json")
				if err := os.WriteFile(rawPath, data, 0600); err != nil {
					peers.close()
					return err
				}
				result.RawPath = rawPath
				result.raw = nil
				if err := peers.close(); err != nil {
					return err
				}
				if err := emit(opt.output, name, result); err != nil {
					return err
				}
				if result.Failures != 0 || result.Corruption != 0 || result.Timeouts != 0 {
					return errors.New("workload failed; see raw artifacts")
				}
			}
		}
	}
	return p.Stop()
}
