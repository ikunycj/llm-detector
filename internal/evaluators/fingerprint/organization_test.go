package fingerprint

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	lmfpd "github.com/Ikaleio/lm-detector/sdk/go"
)

func TestFingerprintOrganizationReachesOnlyConfiguredUpstream(t *testing.T) {
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/custom/v1/chat/completions" || r.Header.Get("OpenAI-Organization") != "org-fixture" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Error("organization relay changed endpoint or credentials")
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{
			"finish_reason": "stop", "message": map[string]string{"content": strings.Repeat("42 ", 300)},
		}}})
	}))
	defer upstream.Close()
	config := lmfpd.DetectConfig{BaseURL: upstream.URL + "/custom/v1", APIKey: "fixture-key", Model: "fixture-model", API: lmfpd.APIChatCompletions, Count: 1, NoStream: true, Timeout: time.Second}
	local, stop, err := organizationEndpoint(context.Background(), config, "org-fixture")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := stop(); err != nil {
			t.Error(err)
		}
	}()
	config.BaseURL = local
	challenges, err := lmfpd.GenerateChallenges(1)
	if err != nil {
		t.Fatal(err)
	}
	// Pin the expected count; prompts/scoring still belong to the SDK.
	challenges[0].ExpectedCount = 300
	sample := lmfpd.RequestSample(context.Background(), config, challenges[0])
	if sample.Error != nil || sample.Count != 300 || sample.State != "complete" {
		t.Fatalf("SDK request through relay: state=%s count=%d error=%v", sample.State, sample.Count, sample.Error)
	}
	response, err := http.Post(local+"/v1/chat/completions", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized || hits.Load() != 1 {
		t.Fatal("relay accepted a request without the call's credential")
	}
}

func TestFingerprintRelayErrorClassifiesConnectionFailures(t *testing.T) {
	target, err := url.Parse("https://example.invalid/v1/chat/completions")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		err  error
		want string
	}{
		{name: "timeout", err: context.DeadlineExceeded, want: "connection timed out"},
		{name: "refused", err: syscall.ECONNREFUSED, want: "connection refused"},
		{name: "network-unreachable", err: syscall.ENETUNREACH, want: "network unreachable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			message := fingerprintRelayError(target, test.err)
			if !strings.Contains(message, "example.invalid") || !strings.Contains(message, test.want) {
				t.Fatalf("message=%q, want host and %q", message, test.want)
			}
		})
	}
}
