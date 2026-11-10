package providers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llm-intelligence/pkg/provider"
)

func TestProviderTimeoutAndRedirect(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(100 * time.Millisecond) }))
		defer srv.Close()
		p := NewOpenAICompatible(20 * time.Millisecond)
		_, err := p.Complete(context.Background(), provider.Connection{BaseURL: srv.URL, APIKey: "fixture"}, "test", "hello")
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("err=%v", err)
		}
	})
	t.Run("redirect", func(t *testing.T) {
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("followed redirect with credential") }))
		defer target.Close()
		source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
		defer source.Close()
		_, err := NewOpenAICompatible(time.Second).Complete(context.Background(), provider.Connection{BaseURL: source.URL, APIKey: "fixture"}, "test", "hello")
		if err == nil || !strings.Contains(err.Error(), "307") {
			t.Fatalf("err=%v", err)
		}
	})
}
