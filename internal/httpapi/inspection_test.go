package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llm-detector/internal/auth"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/evaluators/smoke"
	"llm-detector/internal/httpapi"
	"llm-detector/internal/inspection"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/store"
	"llm-detector/pkg/project"
)

type projectFixture struct{ URL string }

func (projectFixture) ID() string { return "newapi" }
func (f projectFixture) Discover(context.Context, project.Connection) ([]project.Channel, error) {
	return []project.Channel{{ID: "1", Name: "Anthropic channel", Groups: []string{"vip"}, BaseURL: f.URL + "/v1", Protocol: "chat_completions", Organization: "org-fixture", Models: []string{"mock-model"}, Enabled: true}}, nil
}
func (projectFixture) ImportKeys(context.Context, project.Connection, []project.Channel, string) (map[string]string, map[string]string, error) {
	return map[string]string{"1": "private-channel-key"}, map[string]string{}, nil
}

func TestInspectionHTTPFlowAndSecretProjection(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "private-channel-key" {
			t.Error("inspection used wrong upstream protocol or key")
		}
		var input struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		text := "hello"
		if strings.Contains(input.Messages[0].Content, "single character") {
			text = "4"
		}
		if strings.Contains(input.Messages[0].Content, "JSON") {
			text = `{"status":"ok"}`
		}
		json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]string{"type": "text", "text": text}}})
	}))
	defer upstream.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := providers.NewRegistry()
	if err := p.Register(providers.NewOpenAICompatible(time.Second)); err != nil {
		t.Fatal(err)
	}
	e := evaluators.NewRegistry()
	if err := e.Register(smoke.Engine{}); err != nil {
		t.Fatal(err)
	}
	scans := scan.NewService(ctx, p, e, store.NewMemory())
	file, state, err := inspection.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := inspection.NewService(ctx, file, state, scans, e, projectFixture{URL: upstream.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); jobs.Wait(); scans.Wait() })
	h := httpapi.NewServer(auth.NewService("fixture-login-key", time.Hour), p, e, scans, "", jobs, nil)
	if status, _ := send(t, h, "GET", "/api/v1/inspection/projects", "", nil); status != 401 {
		t.Fatal("inspection endpoint is unauthenticated")
	}
	token := login(t, h)
	status, data := send(t, h, "POST", "/api/v1/inspection/projects", token, map[string]any{"name": "local project", "kind": "newapi", "base_url": "http://admin.invalid", "user_id": 1, "access_token": "private-admin-token"})
	if status != 201 {
		t.Fatalf("create: %d %s", status, data)
	}
	var created inspection.Project
	if err := json.Unmarshal(data, &created); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, []byte("private-admin-token")) {
		t.Fatal("create leaked admin token")
	}
	base := "/api/v1/inspection/projects/" + created.ID
	if status, data = send(t, h, "POST", base+"/sync", token, nil); status != 200 {
		t.Fatalf("sync: %d %s", status, data)
	}
	for _, input := range []map[string]any{
		{},
		{"two_factor_code": ""},
		{"two_factor_code": "   "},
		{"two_factor_code": "12345"},
		{"two_factor_code": "12345x"},
	} {
		input["import_keys"] = true
		if status, data = send(t, h, "POST", base+"/sync", token, input); status != 400 {
			t.Fatalf("sync accepted missing or invalid 2FA: %d %s", status, data)
		}
		delete(input, "import_keys")
		input["channel_ids"] = []string{"1"}
		if status, data = send(t, h, "POST", base+"/keys", token, input); status != 400 {
			t.Fatalf("key import accepted missing or invalid 2FA: %d %s", status, data)
		}
	}
	if status, data = send(t, h, "POST", base+"/sync", token, map[string]any{"import_keys": true, "two_factor_code": "123456"}); status != 200 {
		t.Fatalf("combined sync: %d %s", status, data)
	}
	var synced inspection.Project
	if err := json.Unmarshal(data, &synced); err != nil {
		t.Fatal(err)
	}
	if len(synced.Channels) != 1 || !synced.Channels[0].HasKey {
		t.Fatal("combined sync did not import the available channel key")
	}
	if status, data = send(t, h, "POST", base+"/keys", token, map[string]any{"channel_ids": []string{"1"}, "two_factor_code": "123456"}); status != 200 {
		t.Fatalf("keys: %d %s", status, data)
	}
	if bytes.Contains(data, []byte("private-channel-key")) {
		t.Fatal("key import leaked channel key")
	}
	protocolPath := base + "/channels/1/protocol"
	if status, _ = send(t, h, "PUT", protocolPath, "", map[string]string{"protocol": "messages"}); status != 401 {
		t.Fatal("protocol update is unauthenticated")
	}
	for _, input := range []map[string]any{{}, {"protocol": nil}, {"protocol": "invalid"}} {
		if status, _ = send(t, h, "PUT", protocolPath, token, input); status != 400 {
			t.Fatal("invalid protocol update accepted")
		}
	}
	if status, data = send(t, h, "PUT", protocolPath, token, map[string]string{"protocol": "messages"}); status != 200 {
		t.Fatalf("protocol: %d %s", status, data)
	}
	plan := inspection.Plan{Mode: "groups", Groups: []string{"vip"}, Evaluators: []string{"smoke"}, IntervalMinutes: 5, Enabled: false}
	if status, data = send(t, h, "PUT", base+"/plan", token, plan); status != 200 {
		t.Fatalf("plan: %d %s", status, data)
	}
	if status, data = send(t, h, "POST", "/api/v1/inspection/batch-run", token, map[string]any{"project_ids": []string{created.ID, "missing"}}); status != 200 {
		t.Fatalf("batch: %d %s", status, data)
	}
	var batch struct {
		Outcomes []struct {
			RunID string `json:"run_id"`
			Error string `json:"error"`
		} `json:"outcomes"`
	}
	if err := json.Unmarshal(data, &batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.Outcomes) != 2 || batch.Outcomes[0].RunID == "" || batch.Outcomes[1].Error == "" {
		t.Fatal("partial batch failure was hidden")
	}
	jobs.Wait()
	status, data = send(t, h, "GET", "/api/v1/inspection/runs?project_id="+created.ID, token, nil)
	if status != 200 {
		t.Fatalf("runs: %d %s", status, data)
	}
	var results struct {
		Runs []inspection.Run `json:"runs"`
	}
	if err := json.Unmarshal(data, &results); err != nil {
		t.Fatal(err)
	}
	if len(results.Runs) != 1 || results.Runs[0].Status != "completed" || results.Runs[0].Items[0].Result == nil {
		t.Fatalf("batch not complete: %s", data)
	}
	for _, check := range results.Runs[0].Items[0].Result.Models[0].Report.Checks {
		if check.Status != "passed" {
			t.Fatal("upstream smoke result not propagated")
		}
	}
	if bytes.Contains(data, []byte("private-channel-key")) || bytes.Contains(data, []byte("private-admin-token")) {
		t.Fatal("run leaked credentials")
	}
}
