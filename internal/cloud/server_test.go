package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"llm-detector/internal/config"
	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func call(t *testing.T, h http.Handler, method, path, token string, body any) (int, []byte) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code, w.Body.Bytes()
}
func TestCloudRoutesAreAccountScopedAndDoNotReturnKeys(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	alice, err := db.CreateUser("alice", "fixture-alice-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CreateUser("bob", "fixture-bob-password"); err != nil {
		t.Fatal(err)
	}
	_, a, _, _ := db.Login("alice", "fixture-alice-password", time.Hour)
	_, b, _, _ := db.Login("bob", "fixture-bob-password", time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server, err := NewServer(ctx, config.Config{DataDir: t.TempDir(), RequestTimeout: time.Second, TerminalBenchBinary: "missing-harbor"}, db)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	if status, _ := call(t, server, "GET", "/api/v1/scans", "", nil); status != 401 {
		t.Fatal("anonymous cloud read allowed")
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer fixture-model-key" {
			t.Error("wrong saved credential or endpoint")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"fixture-model"}]}`))
	}))
	defer upstream.Close()
	input := []ModelAPI{{ID: "api-a", Name: "Alice API", Vendor: "openai-compatible", BaseURL: upstream.URL + "/v1", Protocol: "chat_completions", APIKey: "fixture-model-key", Scope: "all", Models: []string{}, UpdatedAt: "now"}}
	status, data := call(t, server, "PUT", "/api/v1/model-services", a, input)
	if status != 200 || bytes.Contains(data, []byte("fixture-model-key")) {
		t.Fatalf("save status=%d exposed secret=%v", status, bytes.Contains(data, []byte("fixture-model-key")))
	}
	status, data = call(t, server, "GET", "/api/v1/model-services", b, nil)
	if status != 200 || bytes.Contains(data, []byte("api-a")) {
		t.Fatal("cross-account configuration leak")
	}
	status, _ = call(t, server, "POST", "/api/v1/models/discover", b, map[string]any{"service_id": "api-a"})
	if status != 404 || calls != 0 {
		t.Fatal("other account used saved key")
	}
	status, _ = call(t, server, "POST", "/api/v1/models/discover", a, map[string]any{"service_id": "api-a", "base_url": "https://attacker.invalid"})
	if status != 200 || calls != 1 {
		t.Fatal("saved API credential resolution failed")
	}
	input[0].APIKey = ""
	input[0].Name = "Renamed"
	if status, _ = call(t, server, "PUT", "/api/v1/model-services", a, input); status != 200 {
		t.Fatal("blank edit did not retain key")
	}
	services, err := server.loadServices(alice.ID)
	if err != nil || services[0].APIKey != "fixture-model-key" {
		t.Fatal("saved key was erased")
	}
	store := ScanStore{db, alice.ID}
	if err = store.Save(scan.Scan{ID: "private-scan", Status: "completed", Evaluator: evaluator.Descriptor{ID: "fingerprint"}}); err != nil {
		t.Fatal(err)
	}
	if status, _ = call(t, server, "GET", "/api/v1/scans/private-scan", b, nil); status != 404 {
		t.Fatal("cross-account scan read allowed")
	}
	if status, _ = call(t, server, "GET", "/api/v1/scans/private-scan", a, nil); status != 200 {
		t.Fatal("owner cannot read scan")
	}
	status, data = call(t, server, "POST", "/api/v1/inspection/projects", a, map[string]any{"name": "Private project", "kind": "newapi", "base_url": "https://fixture.invalid", "user_id": 1, "access_token": "fixture-admin-key"})
	if status != 201 {
		t.Fatalf("create project status %d", status)
	}
	var project struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &project) != nil {
		t.Fatal("invalid project response")
	}
	if status, _ = call(t, server, "DELETE", "/api/v1/inspection/projects/"+project.ID, b, nil); status != 404 {
		t.Fatal("cross-account project deletion allowed")
	}
}
