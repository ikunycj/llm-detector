package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"llm-detector/internal/cloud"
	"llm-detector/internal/config"
)

func TestWorkerKeyOriginPersistenceAndCredentialResolution(t *testing.T) {
	dir := t.TempDir()
	db, err := cloud.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cfg := config.Config{DataDir: dir, RequestTimeout: time.Second, TerminalBenchBinary: "missing-harbor"}
	s, err := New(ctx, cfg, db, "fixture-worker-key", []string{"https://ui.test"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); s.Wait() }()
	call := func(method, path, key, origin string, input any) *httptest.ResponseRecorder {
		body, _ := json.Marshal(input)
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		if key != "" {
			r.Header.Set("Authorization", "Bearer "+key)
		}
		r.Header.Set("Origin", origin)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		key, origin string
		status      int
	}{{"", "https://ui.test", 401}, {"wrong", "https://ui.test", 401}, {"fixture-worker-key", "https://evil.test", 403}, {"fixture-worker-key", "https://ui.test", 200}} {
		w := call("GET", "/api/v1/worker/info", test.key, test.origin, nil)
		if w.Code != test.status {
			t.Fatalf("info code=%d want=%d", w.Code, test.status)
		}
	}
	if w := call("OPTIONS", "/api/v1/model-services", "", "https://ui.test", nil); w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != "https://ui.test" {
		t.Fatal("preflight failed")
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer model-fixture-key" || r.URL.Path != "/v1/models" {
			t.Error("saved connection was not resolved")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"fixture-model"}]}`))
	}))
	defer upstream.Close()
	data := []cloud.ModelAPI{{ID: "service", Name: "Worker API", Vendor: "openai-compatible", Protocol: "responses", BaseURL: upstream.URL + "/v1", APIKey: "model-fixture-key", Scope: "all", Models: []string{}}}
	if w := call("PUT", "/api/v1/model-services", "fixture-worker-key", "https://ui.test", data); w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("model-fixture-key")) {
		t.Fatalf("save failed/redacted=%d", w.Code)
	}
	if w := call("POST", "/api/v1/models/discover", "fixture-worker-key", "https://ui.test", map[string]string{"service_id": "service", "base_url": "https://wrong.invalid"}); w.Code != 200 || calls != 1 {
		t.Fatalf("saved credential execution failed: %d", w.Code)
	}
	if w := call("POST", "/api/v1/model-services/transfer", "fixture-worker-key", "https://ui.test", map[string]string{"id": "service"}); w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("model-fixture-key")) {
		t.Fatal("explicit transfer failed")
	}
	if w := call("POST", "/api/v1/model-services/transfer", "wrong", "https://ui.test", map[string]string{"id": "service"}); w.Code != 401 || bytes.Contains(w.Body.Bytes(), []byte("model-fixture-key")) {
		t.Fatal("unauthorized secret transfer")
	}
	cancel()
	s.Wait()
	ctx2, cancel2 := context.WithCancel(context.Background())
	defer cancel2()
	s2, err := New(ctx2, cfg, db, "fixture-worker-key", []string{"https://ui.test"}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel2(); s2.Wait() }()
	r := httptest.NewRequest("GET", "/api/v1/model-services", nil)
	r.Header.Set("Authorization", "Bearer fixture-worker-key")
	w := httptest.NewRecorder()
	s2.ServeHTTP(w, r)
	if w.Code != 200 || !bytes.Contains(w.Body.Bytes(), []byte("Worker API")) || bytes.Contains(w.Body.Bytes(), []byte("model-fixture-key")) {
		t.Fatal("Worker data did not persist across restart")
	}
}
