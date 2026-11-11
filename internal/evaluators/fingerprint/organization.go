package fingerprint

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"syscall"
	"time"

	lmfpd "github.com/Ikaleio/lm-detector/sdk/go"
)

func fingerprintRelayError(target *url.URL, err error) string {
	host := ""
	if target != nil {
		host = target.Host
	}
	prefix := "fingerprint upstream connection failed"
	if host != "" {
		prefix += " to " + host
	}
	if err == nil {
		return prefix
	}
	var dnsErr *net.DNSError
	var netErr net.Error
	switch {
	case errors.As(err, &dnsErr):
		return prefix + ": DNS lookup failed"
	case errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &netErr) && netErr.Timeout()):
		return prefix + ": connection timed out"
	case errors.Is(err, syscall.ECONNREFUSED):
		return prefix + ": connection refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return prefix + ": network unreachable"
	default:
		return prefix + ": transport error"
	}
}

// The SDK has no per-request header/client option. A call-scoped loopback relay
// adds Organization while leaving its request body, streaming and scoring intact.
// It forwards only this call's credential to the fixed SDK-resolved endpoint.
func organizationEndpoint(ctx context.Context, config lmfpd.DetectConfig, organization string) (string, func() error, error) {
	request, err := lmfpd.BuildRequest(config, "")
	if err != nil {
		return "", nil, err
	}
	target, err := url.Parse(request.URL)
	if err != nil {
		return "", nil, errors.New("invalid fingerprint upstream URL")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, errors.New("cannot start fingerprint organization relay")
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			endpoint := *target
			r.Out.URL = &endpoint
			r.Out.Host = endpoint.Host
			r.Out.Header.Set("OpenAI-Organization", organization)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, proxyErr error) {
			http.Error(w, fingerprintRelayError(target, proxyErr), http.StatusBadGateway)
		},
	}
	server := &http.Server{
		ReadHeaderTimeout: 5 * time.Second,
		BaseContext:       func(net.Listener) context.Context { return ctx },
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer "+strings.TrimSpace(config.APIKey) {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			proxy.ServeHTTP(w, r)
		}),
	}
	done := make(chan error, 1)
	go func() {
		done <- server.Serve(listener)
	}()
	stop := func() error {
		closeErr := server.Close()
		serveErr := <-done
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			return errors.New("fingerprint organization relay stopped unexpectedly")
		}
		if closeErr != nil {
			return errors.New("could not close fingerprint organization relay")
		}
		return nil
	}
	return "http://" + listener.Addr().String(), stop, nil
}
