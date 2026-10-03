package integration

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"io"
	"math/big"
	"strings"
	"testing"
	"time"

	"passio/relay/internal/fixture"
)

func certificate(t *testing.T) (tls.Certificate, *x509.Certificate) {
	t.Helper()
	pub, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "endpoint.test"}, DNSNames: []string{"endpoint.test"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, pub, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, cert
}

func encryptedPair(t *testing.T, h *fixture.Host, serverCert tls.Certificate, pin *x509.Certificate, valid bool) (*tls.Conn, *tls.Conn, *fixture.Stream) {
	t.Helper()
	c, a := pairSockets(t, h)
	clientStream := &fixture.Stream{Conn: c}
	serverStream := &fixture.Stream{Conn: a}
	roots := x509.NewCertPool()
	roots.AddCert(pin)
	client := tls.Client(clientStream, &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, RootCAs: roots, ServerName: "endpoint.test", VerifyConnection: func(cs tls.ConnectionState) error {
		if !bytes.Equal(cs.PeerCertificates[0].Raw, pin.Raw) {
			return errors.New("host identity mismatch")
		}
		return nil
	}})
	server := tls.Server(serverStream, &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCert}, SessionTicketsDisabled: true})
	client.SetDeadline(time.Now().Add(5 * time.Second))
	server.SetDeadline(time.Now().Add(5 * time.Second))
	result := make(chan error, 1)
	go func() { result <- server.Handshake() }()
	err := client.Handshake()
	if valid && err != nil {
		t.Fatal(err)
	}
	if !valid {
		var verification *tls.CertificateVerificationError
		if !errors.As(err, &verification) {
			t.Fatalf("expected identity verification failure, got %v", err)
		}
	}
	select {
	case err := <-result:
		if valid && err != nil {
			t.Fatal(err)
		}
	case <-deadline(t).Done():
		t.Fatal("TLS handshake did not finish")
	}
	if valid && client.ConnectionState().Version != tls.VersionTLS13 {
		t.Fatal("TLS version mismatch")
	}
	return client, server, clientStream
}

func exchange(t *testing.T, client, server *tls.Conn) {
	t.Helper()
	request := []byte(`{"operation":"sum","values":[3,8]}`)
	response := []byte("<result>11</result>")
	if _, err := client.Write(request); err != nil {
		t.Fatal(err)
	}
	received := make([]byte, len(request))
	if _, err := io.ReadFull(server, received); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(request, received) {
		t.Fatal("encrypted request corrupted")
	}
	if _, err := server.Write(response); err != nil {
		t.Fatal(err)
	}
	received = make([]byte, len(response))
	if _, err := io.ReadFull(client, received); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(response, received) {
		t.Fatal("encrypted response corrupted")
	}
}

func TestEndpointTLS13(t *testing.T) {
	p := start(t, nil)
	cert, pin := certificate(t)
	t.Run("request_response_and_fresh_reconnect", func(t *testing.T) {
		h := host(t, p, nil)
		client, server, _ := encryptedPair(t, h, cert, pin, true)
		exchange(t, client, server)
		h.Control.WriteControl(8, []byte{3, 232}, time.Now().Add(time.Second))
		closed(t, client.NetConn().(*fixture.Stream).Conn, 1000)
		fresh := host(t, p, h.Key)
		next, peer, _ := encryptedPair(t, fresh, cert, pin, true)
		exchange(t, next, peer)
	})
	t.Run("wrong_host_identity", func(t *testing.T) {
		wrong, _ := certificate(t)
		h := host(t, p, nil)
		encryptedPair(t, h, wrong, pin, false)
	})
	for _, attack := range []string{"modified_ciphertext", "replayed_record"} {
		t.Run(attack, func(t *testing.T) {
			h := host(t, p, nil)
			client, server, stream := encryptedPair(t, h, cert, pin, true)
			exchange(t, client, server)
			stream.Transform = func(p []byte) [][]byte {
				captured := append([]byte(nil), p...)
				if attack == "modified_ciphertext" {
					captured[len(captured)-1] ^= 1
					return [][]byte{captured}
				}
				return [][]byte{captured, captured}
			}
			request := []byte("authenticated record")
			if _, err := client.Write(request); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, len(request))
			if attack == "replayed_record" {
				if _, err := io.ReadFull(server, buf); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(buf, request) {
					t.Fatal("first record corrupted")
				}
			}
			_, err := server.Read(buf)
			if err == nil || !strings.Contains(err.Error(), "bad record MAC") {
				t.Fatalf("expected TLS record authentication failure, got %v", err)
			}
		})
	}
}
