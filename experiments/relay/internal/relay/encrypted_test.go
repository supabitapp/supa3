package relay_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"passio-relay/internal/endpoint"
)

type testCert struct {
	tls tls.Certificate
	pin [32]byte
}

func newTestCert(t *testing.T) testCert {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "passio-test-host"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return testCert{tls: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, pin: sha256.Sum256(der)}
}

func pinnedClientConfig(pin [32]byte) *tls.Config {
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		InsecureSkipVerify: true,
		VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			if len(rawCerts) == 0 || sha256.Sum256(rawCerts[0]) != pin {
				return errors.New("host certificate does not match pinned identity")
			}
			return nil
		},
	}
}

type tamper int

const (
	tamperNone tamper = iota
	tamperFlipByte
	tamperReplay
)

func serveEncryptedHost(t *testing.T, h *endpoint.Host, cert testCert, mode tamper) {
	t.Helper()
	c := ctx(t)
	go func() {
		msg, err := h.WaitEvent(c, "incoming", "")
		if err != nil {
			t.Errorf("incoming: %v", err)
			return
		}
		raw, _, err := h.Accept(c, msg.ConnectionID, msg.Token)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		defer raw.Close()
		stream := endpoint.NewStreamConn(raw)
		stream.SetDeadline(time.Now().Add(deadline))
		conn := tls.Server(stream, &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert.tls}})
		defer conn.Close()
		if err := conn.Handshake(); err != nil {
			return
		}
		switch mode {
		case tamperFlipByte:
			stream.Intercept = func(frame []byte) [][]byte {
				out := append([]byte(nil), frame...)
				out[len(out)-1] ^= 0x01
				return [][]byte{out}
			}
		case tamperReplay:
			stream.Intercept = func(frame []byte) [][]byte { return [][]byte{frame, frame} }
		}
		buf := make([]byte, 1024)
		for {
			n, err := conn.Read(buf)
			if err != nil {
				return
			}
			reply := "pong:" + strings.TrimPrefix(string(buf[:n]), "ping:")
			if _, err := conn.Write([]byte(reply)); err != nil {
				return
			}
		}
	}()
}

func encryptedClient(t *testing.T, r *testRelay, endpointID string, cfg *tls.Config) *tls.Conn {
	t.Helper()
	raw := mustConnect(t, r, endpointID)
	stream := endpoint.NewStreamConn(raw)
	stream.SetDeadline(time.Now().Add(deadline))
	conn := tls.Client(stream, cfg)
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestEncryptedEndpointExchange(t *testing.T) {
	r := startRelay(t, nil)
	h := mustRegister(t, r, endpoint.NewIdentity())
	hostCert := newTestCert(t)
	imposterCert := newTestCert(t)
	clientCfg := pinnedClientConfig(hostCert.pin)
	exchange := func(conn *tls.Conn, body string) (string, error) {
		if _, err := conn.Write([]byte("ping:" + body)); err != nil {
			return "", err
		}
		buf := make([]byte, 1024)
		n, err := conn.Read(buf)
		return string(buf[:n]), err
	}

	t.Run("request response", func(t *testing.T) {
		serveEncryptedHost(t, h, hostCert, tamperNone)
		conn := encryptedClient(t, r, h.Identity.EndpointID, clientCfg)
		if err := conn.Handshake(); err != nil {
			t.Fatal(err)
		}
		if conn.ConnectionState().Version != tls.VersionTLS13 {
			t.Fatalf("negotiated version %x", conn.ConnectionState().Version)
		}
		for i := 0; i < 3; i++ {
			got, err := exchange(conn, "hello")
			if err != nil || got != "pong:hello" {
				t.Fatalf("exchange %d: %q %v", i, got, err)
			}
		}
	})

	t.Run("wrong host identity", func(t *testing.T) {
		serveEncryptedHost(t, h, imposterCert, tamperNone)
		conn := encryptedClient(t, r, h.Identity.EndpointID, clientCfg)
		err := conn.Handshake()
		if err == nil || !strings.Contains(err.Error(), "pinned identity") {
			t.Fatalf("expected pinning failure, got %v", err)
		}
	})

	t.Run("modified ciphertext", func(t *testing.T) {
		serveEncryptedHost(t, h, hostCert, tamperFlipByte)
		conn := encryptedClient(t, r, h.Identity.EndpointID, clientCfg)
		if err := conn.Handshake(); err != nil {
			t.Fatal(err)
		}
		got, err := exchange(conn, "tamper")
		if err == nil {
			t.Fatalf("expected record rejection, got %q", got)
		}
		t.Logf("modified ciphertext rejected: %v", err)
	})

	t.Run("replayed record", func(t *testing.T) {
		serveEncryptedHost(t, h, hostCert, tamperReplay)
		conn := encryptedClient(t, r, h.Identity.EndpointID, clientCfg)
		if err := conn.Handshake(); err != nil {
			t.Fatal(err)
		}
		got, err := exchange(conn, "replay")
		if err != nil || got != "pong:replay" {
			t.Fatalf("first copy: %q %v", got, err)
		}
		buf := make([]byte, 1024)
		if n, err := conn.Read(buf); err == nil {
			t.Fatalf("replayed record accepted: %q", buf[:n])
		} else {
			t.Logf("replayed record rejected: %v", err)
		}
	})

	t.Run("fresh reconnect", func(t *testing.T) {
		serveEncryptedHost(t, h, hostCert, tamperNone)
		conn := encryptedClient(t, r, h.Identity.EndpointID, clientCfg)
		got, err := exchange(conn, "again")
		if err != nil || got != "pong:again" {
			t.Fatalf("exchange: %q %v", got, err)
		}
	})

	m := metrics(t, r)
	if m.ForwardedMessages == 0 || m.ForwardedBytes == 0 {
		t.Fatalf("relay forwarded nothing: %+v", m)
	}
	_ = websocket.BinaryMessage
}
