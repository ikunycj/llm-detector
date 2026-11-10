package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llm-intelligence/internal/auth"
	"llm-intelligence/internal/evaluators"
	"llm-intelligence/internal/evaluators/smoke"
	"llm-intelligence/internal/httpapi"
	"llm-intelligence/internal/providers"
	"llm-intelligence/internal/scan"
	"llm-intelligence/internal/store"
	"llm-intelligence/pkg/evaluator"
)

const fixtureAPIKey = "fixture-provider-secret"

func setup(t *testing.T, engine evaluator.Engine) (http.Handler, *scan.Service) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	p := providers.NewRegistry()
	if err := p.Register(providers.NewOpenAICompatible(time.Second)); err != nil {
		t.Fatal(err)
	}
	e := evaluators.NewRegistry()
	if err := e.Register(engine); err != nil {
		t.Fatal(err)
	}
	s := scan.NewService(ctx, p, e, store.NewMemory())
	t.Cleanup(func() { cancel(); s.Wait() })
	return httpapi.NewServer(auth.NewService("fixture-login-key", time.Hour), p, e, s, ""), s
}
func send(t *testing.T, h http.Handler, method, path, token string, payload any) (int, []byte) {
	t.Helper()
	var body []byte
	var err error
	if payload != nil {
		body, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code, w.Body.Bytes()
}
func login(t *testing.T, h http.Handler) string {
	t.Helper()
	status, data := send(t, h, "POST", "/api/v1/auth/login", "", map[string]string{"key": "fixture-login-key"})
	if status != 200 {
		t.Fatalf("login=%d %s", status, data)
	}
	var result struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result.Token
}
func waitScan(t *testing.T, h http.Handler, token, id string) scan.Scan {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for {
		status, data := send(t, h, "GET", "/api/v1/scans/"+id, token, nil)
		if status != 200 {
			t.Fatalf("get=%d %s", status, data)
		}
		if bytes.Contains(data, []byte(fixtureAPIKey)) {
			t.Fatal("credential leaked into result")
		}
		var item scan.Scan
		if err := json.Unmarshal(data, &item); err != nil {
			t.Fatal(err)
		}
		if item.Status != "pending" && item.Status != "running" {
			return item
		}
		select {
		case <-timer.C:
			t.Fatal("scan did not finish")
		case <-tick.C:
		}
	}
}
func scanInput(base, scope string, models []string) map[string]any {
	return map[string]any{"vendor": "openai-compatible", "base_url": base, "api_key": fixtureAPIKey, "scope": scope, "models": models, "evaluator": "smoke"}
}

func TestLoginDiscoveryAndAllModelScan(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fixtureAPIKey {
			t.Error("missing provider credential")
		}
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/models" {
			io.WriteString(w, `{"data":[{"id":"beta"},{"id":"alpha"},{"id":"alpha"}]}`)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("unexpected route %s", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		var body struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			return
		}
		output := "Hello"
		if strings.Contains(body.Messages[0].Content, "single character") {
			output = "4"
		}
		if strings.Contains(body.Messages[0].Content, "JSON") {
			output = `{"status":"ok"}`
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": output}}}})
	}))
	defer upstream.Close()
	h, _ := setup(t, smoke.Engine{})
	if status, _ := send(t, h, "GET", "/api/v1/scans", "", nil); status != 401 {
		t.Fatalf("protected status=%d", status)
	}
	if status, _ := send(t, h, "POST", "/api/v1/auth/login", "", map[string]string{"key": "wrong"}); status != 401 {
		t.Fatalf("wrong login=%d", status)
	}
	token := login(t, h)
	status, data := send(t, h, "POST", "/api/v1/models/discover", token, map[string]string{"vendor": "openai-compatible", "base_url": upstream.URL + "/v1/", "api_key": fixtureAPIKey})
	if status != 200 {
		t.Fatalf("discover=%d %s", status, data)
	}
	var discovery struct {
		Models []struct {
			ID string `json:"id"`
		} `json:"models"`
	}
	if err := json.Unmarshal(data, &discovery); err != nil {
		t.Fatal(err)
	}
	if len(discovery.Models) != 2 || discovery.Models[0].ID != "alpha" {
		t.Fatalf("models=%+v", discovery.Models)
	}
	status, data = send(t, h, "POST", "/api/v1/scans", token, scanInput(upstream.URL+"/v1", "all", nil))
	if status != 202 {
		t.Fatalf("create=%d %s", status, data)
	}
	var created scan.Scan
	if err := json.Unmarshal(data, &created); err != nil {
		t.Fatal(err)
	}
	result := waitScan(t, h, token, created.ID)
	if result.Status != "completed" || len(result.Models) != 2 || result.CompletedAt == nil {
		t.Fatalf("result=%+v", result)
	}
	for _, model := range result.Models {
		if len(model.Report.Checks) != 3 {
			t.Fatal("missing checks")
		}
		for _, check := range model.Report.Checks {
			if check.Status != "passed" {
				t.Fatalf("check=%+v", check)
			}
		}
	}
	status, _ = send(t, h, "POST", "/api/v1/auth/logout", token, nil)
	if status != 204 {
		t.Fatalf("logout=%d", status)
	}
	if status, _ = send(t, h, "GET", "/api/v1/scans", token, nil); status != 401 {
		t.Fatal("revoked token still valid")
	}
}

func TestSelectedModelsSkipDiscoveryAndDistinguishErrors(t *testing.T) {
	var discoveries atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			discoveries.Add(1)
			http.Error(w, "unsupported", 404)
			return
		}
		var body struct {
			Model string `json:"model"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.Model == "broken" {
			http.Error(w, fixtureAPIKey, 429)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "wrong answer " + fixtureAPIKey}}}})
	}))
	defer upstream.Close()
	h, _ := setup(t, smoke.Engine{})
	token := login(t, h)
	for _, test := range []struct{ model, status, checkStatus string }{{"wrong", "completed", "failed"}, {"broken", "completed_with_errors", "error"}} {
		status, data := send(t, h, "POST", "/api/v1/scans", token, scanInput(upstream.URL+"/v1", "selected", []string{test.model, test.model}))
		if status != 202 {
			t.Fatalf("start=%d %s", status, data)
		}
		var created scan.Scan
		json.Unmarshal(data, &created)
		item := waitScan(t, h, token, created.ID)
		if item.Status != test.status || len(item.Models) != 1 {
			t.Fatalf("result=%+v", item)
		}
		if item.Models[0].Report.Checks[1].Status != test.checkStatus {
			t.Fatal("evaluation and transport errors conflated")
		}
	}
	if discoveries.Load() != 0 {
		t.Fatal("selected models required discovery")
	}
}

func TestRejectInvalidScanRequests(t *testing.T) {
	h, _ := setup(t, smoke.Engine{})
	token := login(t, h)
	for _, change := range []map[string]any{
		{"scope": "selected", "models": []string{}}, {"scope": "all", "models": []string{"x"}},
		{"scope": "invalid"}, {"evaluator": "not-installed"}, {"vendor": "not-installed"},
		{"api_key": ""}, {"models": []string{" "}}, {"base_url": "file:///tmp/example"},
		{"base_url": "https://user:secret@example.com/v1"}, {"base_url": "https://example.com/v1?key=secret"},
	} {
		input := scanInput("http://127.0.0.1:1/v1", "selected", []string{"x"})
		for key, value := range change {
			input[key] = value
		}
		status, _ := send(t, h, "POST", "/api/v1/scans", token, input)
		if status != 400 {
			t.Errorf("accepted %v: %d", change, status)
		}
	}
	r := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader(`{"key":"fixture-login-key"} {}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("trailing JSON accepted")
	}
}

type optionalEngine struct{}

func (optionalEngine) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{ID: "optional", Name: "Test plugin", Version: "1"}
}
func (optionalEngine) Run(context.Context, evaluator.Target) (evaluator.Report, error) {
	return evaluator.Report{Checks: []evaluator.Check{{ID: "custom", Name: "SDK result", Status: "passed"}}}, nil
}
func TestOptionalEvaluatorSelection(t *testing.T) {
	h, _ := setup(t, optionalEngine{})
	token := login(t, h)
	input := scanInput("http://127.0.0.1:1/v1", "selected", []string{"manual-model"})
	input["evaluator"] = "optional"
	status, data := send(t, h, "POST", "/api/v1/scans", token, input)
	if status != 202 {
		t.Fatalf("start=%d %s", status, data)
	}
	var created scan.Scan
	json.Unmarshal(data, &created)
	item := waitScan(t, h, token, created.ID)
	if item.Evaluator.ID != "optional" || item.Models[0].Report.Checks[0].ID != "custom" {
		t.Fatal("optional engine not invoked")
	}
}

func TestStaticHostingAndAPIRoutes(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>LLM Intelligence</h1>"), 0600); err != nil {
		t.Fatal(err)
	}
	p := providers.NewRegistry()
	e := evaluators.NewRegistry()
	scans := scan.NewService(context.Background(), p, e, store.NewMemory())
	handler := httpapi.NewServer(auth.NewService("fixture-login-key", time.Hour), p, e, scans, dir)
	status, data := send(t, handler, "GET", "/", "", nil)
	if status != 200 || !bytes.Contains(data, []byte("LLM Intelligence")) {
		t.Fatalf("static page: %d %s", status, data)
	}
	status, data = send(t, handler, "GET", "/api/unknown", "", nil)
	if status != 404 || bytes.Contains(data, []byte("<h1>")) {
		t.Fatalf("API fell through to static: %d %s", status, data)
	}
	if status, _ = send(t, handler, "GET", "/api/v1/scans", "", nil); status != 401 {
		t.Fatalf("auth status: %d", status)
	}
}
