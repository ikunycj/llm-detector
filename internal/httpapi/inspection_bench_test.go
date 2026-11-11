package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"llm-detector/internal/auth"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/evaluators/fingerprint"
	benchevaluator "llm-detector/internal/evaluators/terminalbench"
	"llm-detector/internal/httpapi"
	"llm-detector/internal/inspection"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/store"
	"llm-detector/internal/terminalbench"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/project"
)

type benchProject struct{}

func (benchProject) ID() string { return "newapi" }
func (benchProject) Discover(context.Context, project.Connection) ([]project.Channel, error) {
	return []project.Channel{{ID: "1", Name: "bench channel", BaseURL: "https://upstream.invalid/v1", Protocol: "messages", Models: []string{"model-a", "model-b"}, Enabled: true}}, nil
}
func (benchProject) ImportKeys(context.Context, project.Connection, []project.Channel, string) (map[string]string, map[string]string, error) {
	return map[string]string{"1": "fixture-bench-key"}, map[string]string{}, nil
}

type benchFixtureRunner struct {
	t     *testing.T
	calls chan string
}

func (f benchFixtureRunner) Check(context.Context) terminalbench.Readiness {
	return terminalbench.Readiness{Ready: true}
}
func (f benchFixtureRunner) Run(_ context.Context, dir, key string) error {
	data, err := os.ReadFile(filepath.Join(dir, "input.json"))
	if err != nil {
		return err
	}
	var config struct {
		Concurrency int                  `json:"n_concurrent_trials"`
		Tasks       []terminalbench.Task `json:"tasks"`
		Agents      []struct {
			Model  string `json:"model_name"`
			URL    string `json:"base_url"`
			Format string `json:"model_api_format"`
		} `json:"agents"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return err
	}
	if key != "fixture-bench-key" || bytes.Contains(data, []byte(key)) {
		f.t.Error("channel key missing or stored in config")
	}
	if len(config.Tasks) != 6 || config.Concurrency != 2 || len(config.Agents) != 1 || config.Agents[0].URL != "https://upstream.invalid/v1" || config.Agents[0].Format != "anthropic_messages" {
		f.t.Error("Harbor received wrong suite, concurrency or channel connection")
	}
	catalog, err := terminalbench.LoadCatalog()
	if err != nil {
		return err
	}
	nameByPath := map[string]string{}
	for _, task := range catalog.Tasks {
		nameByPath[task.Path] = task.Name
	}
	for i, task := range config.Tasks {
		dir := filepath.Join(dir, "harbor", task.Path+"__fixture")
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		reward := 1
		if i == 0 {
			reward = 0
		}
		result := map[string]any{"task_name": nameByPath[task.Path], "finished_at": time.Now().UTC(), "verifier_result": map[string]any{"rewards": map[string]int{"reward": reward}}}
		data, err := json.Marshal(result)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(dir, "result.json"), data, 0600); err != nil {
			return err
		}
	}
	f.calls <- config.Agents[0].Model
	return nil
}

func TestInspectionRunsTerminalBenchUsingImportedChannelKey(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := make(chan string, 2)
	bench, err := terminalbench.NewService(ctx, t.TempDir(), benchFixtureRunner{t: t, calls: calls})
	if err != nil {
		t.Fatal(err)
	}
	registry := evaluators.NewRegistry()
	for _, engine := range []evaluator.Engine{fingerprint.New("", "", time.Second), benchevaluator.New(bench)} {
		if err := registry.Register(engine); err != nil {
			t.Fatal(err)
		}
	}
	providers := providers.NewRegistry()
	scans := scan.NewService(ctx, providers, registry, store.NewMemory())
	file, state, err := inspection.OpenStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := inspection.NewService(ctx, file, state, scans, registry, benchProject{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); jobs.Wait(); scans.Wait(); bench.Wait() })
	h := httpapi.NewServer(auth.NewService("fixture-login-key", time.Hour), providers, registry, scans, "", jobs, bench)
	token := login(t, h)
	status, data := send(t, h, "GET", "/api/v1/evaluators", token, nil)
	var catalog struct {
		Evaluators []evaluator.Descriptor `json:"evaluators"`
	}
	if status != http.StatusOK || json.Unmarshal(data, &catalog) != nil || len(catalog.Evaluators) != 2 || catalog.Evaluators[0].ID != "fingerprint" || catalog.Evaluators[1].ID != "terminal-bench" || len(catalog.Evaluators[1].Options) != 2 {
		t.Fatalf("inconsistent engine catalog: %s", data)
	}
	p, err := jobs.SaveProject("", inspection.Input{Name: "fixture", Kind: "newapi", BaseURL: "https://admin.invalid", UserID: 1, AccessToken: "fixture-admin-key"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := jobs.SyncAndImport(ctx, p.ID, "123456"); err != nil {
		t.Fatal(err)
	}
	plan := inspection.Plan{Mode: "all", Evaluators: []string{"terminal-bench"}, EvaluatorOptions: map[string]json.RawMessage{"terminal-bench": json.RawMessage(`{"suite":"daily","concurrency":2}`)}, IntervalMinutes: 60}
	status, data = send(t, h, "PUT", "/api/v1/inspection/projects/"+p.ID+"/plan", token, plan)
	if status != http.StatusOK {
		t.Fatalf("save plan: %d %s", status, data)
	}
	var saved inspection.Project
	if json.Unmarshal(data, &saved) != nil || !bytes.Equal(saved.Plan.EvaluatorOptions["terminal-bench"], plan.EvaluatorOptions["terminal-bench"]) {
		t.Fatal("engine settings not retained")
	}
	status, data = send(t, h, "POST", "/api/v1/inspection/projects/"+p.ID+"/run", token, nil)
	if status != http.StatusAccepted {
		t.Fatalf("start: %d %s", status, data)
	}
	jobs.Wait()
	runs, err := jobs.Runs(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || len(runs[0].Items) != 1 || runs[0].Status != "completed" {
		t.Fatalf("batch result: %+v", runs)
	}
	result := runs[0].Items[0].Result
	if result == nil || len(result.Models) != 2 {
		t.Fatal("missing per-model results")
	}
	for _, model := range result.Models {
		if model.Report.Kind != "terminal-bench" || len(model.Report.Checks) != 6 || model.Report.Checks[0].Status != "failed" || model.Status != "completed" {
			t.Fatalf("capability failure confused with execution error: %+v", model)
		}
	}
	got := []string{<-calls, <-calls}
	if !slices.Equal(got, []string{"model-a", "model-b"}) {
		t.Fatal("models were not evaluated sequentially")
	}
	status, data = send(t, h, "GET", "/api/v1/inspection/runs", token, nil)
	if status != http.StatusOK || bytes.Contains(data, []byte("fixture-bench-key")) || bytes.Contains(data, []byte("fixture-admin-key")) {
		t.Fatal("result exposed credentials")
	}
}
