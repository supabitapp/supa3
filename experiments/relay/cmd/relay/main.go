package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"passio-relay/internal/relay"
)

const drainTimeout = 5 * time.Second

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	cfg, err := relay.ConfigFromOSEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid configuration:", err)
		os.Exit(2)
	}
	ln, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, "listen failed:", err)
		os.Exit(1)
	}
	r := relay.New(cfg, logger)
	srv := &http.Server{Handler: r.Handler(), ReadHeaderTimeout: 10 * time.Second}
	json.NewEncoder(os.Stdout).Encode(struct {
		Event   string `json:"event"`
		Address string `json:"address"`
	}{"listening", ln.Addr().String()})

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Serve(ln) }()
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	select {
	case err := <-errCh:
		logger.Error("serve failed", "error", err)
		os.Exit(1)
	case sig := <-sigCh:
		logger.Info("signal received", "signal", sig.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), drainTimeout)
	defer cancel()
	r.Drain(ctx)
	srv.Close()
	logger.Info("exited")
}
