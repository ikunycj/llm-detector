package httpapi_test

import (
	"context"
	"testing"
	"time"

	"llm-detector/internal/auth"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/httpapi"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/store"
	"llm-detector/internal/terminalbench"
)

type unavailableBench struct{}

func (unavailableBench) Check(context.Context) terminalbench.Readiness {
	return terminalbench.Readiness{Ready: false}
}
func (unavailableBench) Run(context.Context, string, string) error {
	panic("should not run without prerequisites")
}
func TestTerminalBenchAPIAuthAndCatalog(t *testing.T) {
	ctx := context.Background()
	p := providers.NewRegistry()
	e := evaluators.NewRegistry()
	scans := scan.NewService(ctx, p, e, store.NewMemory())
	bench, err := terminalbench.NewService(ctx, t.TempDir(), unavailableBench{})
	if err != nil {
		t.Fatal(err)
	}
	h := httpapi.NewServer(auth.NewService("fixture-login-key", time.Hour), p, e, scans, "", nil, bench)
	if status, _ := send(t, h, "GET", "/api/v1/terminal-bench/catalog", "", nil); status != 401 {
		t.Fatal("catalog unprotected")
	}
	token := login(t, h)
	if status, _ := send(t, h, "GET", "/api/v1/terminal-bench/catalog", token, nil); status != 200 {
		t.Fatal("catalog unavailable")
	}
	input := map[string]any{"suite": "daily", "protocol": "chat_completions", "base_url": "https://api.invalid/v1", "api_key": "fixture", "model": "m", "concurrency": 1}
	for _, protocol := range []string{"chat_completions", "responses", "messages"} {
		input["protocol"] = protocol
		if status, _ := send(t, h, "POST", "/api/v1/terminal-bench/jobs", token, input); status != 503 {
			t.Fatalf("supported protocol %s did not reach runtime check: HTTP %d", protocol, status)
		}
	}
	input["protocol"] = "invalid"
	if status, _ := send(t, h, "POST", "/api/v1/terminal-bench/jobs", token, input); status != 400 {
		t.Fatal("invalid protocol accepted")
	}
	input["protocol"] = "responses"
	input["suite"] = "arbitrary-task"
	if status, _ := send(t, h, "POST", "/api/v1/terminal-bench/jobs", token, input); status != 400 {
		t.Fatal("unbounded dataset selection allowed")
	}
}
