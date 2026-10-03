package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"passio/relay/internal/relay"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := relay.LoadConfig()
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		return err
	}
	limited := relay.LimitListener(listener, 3*cfg.MaxClients+64)
	defer limited.CloseConnections()
	service := relay.New(cfg)
	server := &http.Server{Handler: service, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
	done := make(chan error, 1)
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	defer signal.Stop(signals)
	go func() { done <- server.Serve(limited) }()
	json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "listening", "address": listener.Addr().String()})
	select {
	case err := <-done:
		return err
	case <-signals:
	}
	service.BeginDrain()
	fmt.Fprintln(os.Stderr, `{"event":"draining"}`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	service.Drain(ctx)
	shutdown, stop := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer stop()
	server.Shutdown(shutdown)
	return nil
}
