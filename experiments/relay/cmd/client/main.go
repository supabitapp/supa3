package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"syscall"

	"passio/relay/internal/fixture"
)

func main() {
	address := flag.String("address", "127.0.0.1:8080", "isolated relay address")
	mode := flag.String("mode", "client", "echo-host or client")
	endpoint := flag.String("endpoint-id", "", "registered host endpoint ID")
	payload := flag.String("payload", "hello", "text to echo")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	if err := run(ctx, *address, *mode, *endpoint, *payload); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, address, mode, endpoint, payload string) error {
	if mode == "echo-host" {
		h, err := fixture.Register(address, nil)
		if err != nil {
			return err
		}
		defer h.Control.Close()
		json.NewEncoder(os.Stdout).Encode(map[string]string{"event": "registered", "endpointId": h.ID})
		for {
			select {
			case <-ctx.Done():
				return nil
			case record, ok := <-h.Records:
				if !ok {
					return errors.New("control socket closed")
				}
				if record.Type == "incoming" {
					c, _, err := h.Accept(record)
					if err != nil {
						return err
					}
					go fixture.Echo(c)
				}
			}
		}
	}
	if mode != "client" || endpoint == "" {
		return errors.New("use -mode echo-host or -mode client -endpoint-id HEX")
	}
	c, _, err := fixture.Dial(address, "/v1/connect", url.Values{"endpointId": {endpoint}})
	if err != nil {
		return err
	}
	defer c.Close()
	if err := c.WriteMessage(1, []byte(payload)); err != nil {
		return err
	}
	kind, body, err := c.ReadMessage()
	if err != nil {
		return err
	}
	if kind != 1 || string(body) != payload {
		return errors.New("echo mismatch")
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"event": "echo", "bytes": len(body), "verified": true})
}
