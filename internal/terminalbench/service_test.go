package terminalbench

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRunner struct {
	ready   bool
	started chan struct{}
	gate    chan struct{}
	calls   atomic.Int32
}

func (f *fakeRunner) Check(context.Context) Readiness {
	return Readiness{Ready: f.ready, Checks: []Check{{Name: "fixture", Ready: f.ready}}}
}
func (f *fakeRunner) Run(ctx context.Context, dir, key string) error {
	f.calls.Add(1)
	if key != "fixture-secret" {
		return errors.New("wrong credential")
	}
	var cfg struct {
		Tasks []Task `json:"tasks"`
	}
	data, err := os.ReadFile(filepath.Join(dir, "input.json"))
	if err != nil {
		return err
	}
	if strings.Contains(string(data), key) {
		return errors.New("secret written to config")
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return err
	}
	close(f.started)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-f.gate:
	}
	for i, task := range cfg.Tasks {
		trialDir := filepath.Join(dir, "harbor", task.Path+"__fixture")
		if err = os.MkdirAll(trialDir, 0700); err != nil {
			return err
		}
		value := map[string]any{"task_name": task.Path, "started_at": time.Now().UTC(), "finished_at": time.Now().UTC(), "verifier_result": map[string]any{"rewards": map[string]float64{"reward": 1}}}
		if i == 1 {
			value["verifier_result"] = map[string]any{"rewards": map[string]float64{"reward": 0}}
		}
		if i == 2 {
			value["exception_info"] = map[string]string{"exception_type": "NetworkError", "exception_message": key}
		}
		if err = writeJSONFile(filepath.Join(trialDir, "result.json"), value); err != nil {
			return err
		}
	}
	return nil
}
func fixtureInput() Input {
	return Input{Suite: "daily", ServiceName: "fixture", BaseURL: "https://api.invalid/v1", Protocol: "chat_completions", APIKey: "fixture-secret", Model: "custom-model", Concurrency: 1}
}
func waitJob(t *testing.T, s *Service, id string) Job {
	t.Helper()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	for {
		job, err := s.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if job.Status != "running" && job.Status != "cancelling" {
			return job
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("job did not finish")
		}
	}
}
func TestCatalogAndConfiguration(t *testing.T) {
	catalog, err := LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"regex-log", "constraints-scheduling", "cobol-modernization", "cancel-async-tasks", "log-summary-date-ranges", "db-wal-recovery"}
	daily := catalog.Select("daily")
	if len(daily) != 6 || len(catalog.Select("full")) != 89 {
		t.Fatal("suite count mismatch")
	}
	for i, name := range expected {
		if daily[i].Name != name || daily[i].Commit != "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c" {
			t.Fatal("daily task or commit changed")
		}
	}
	for protocol, format := range map[string]string{
		"chat_completions": "openai_chat_completions",
		"responses":        "openai_responses",
		"messages":         "anthropic_messages",
	} {
		input := fixtureInput()
		input.Protocol = protocol
		if err := validateInput(&input); err != nil {
			t.Fatalf("rejected supported protocol %s: %v", protocol, err)
		}
		config := buildConfig(catalog, Job{Suite: "daily", Protocol: protocol, Model: "model", BaseURL: "https://gateway.invalid/v1", Concurrency: 2}, "/tmp/tb")
		data, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "api_key\"") || !strings.Contains(string(data), "TB_MODEL_API_KEY") || strings.Contains(string(data), "upload") {
			t.Fatal("config credential or upload policy incorrect")
		}
		if !strings.Contains(string(data), `"n_attempts":1`) || !strings.Contains(string(data), `"max_retries":0`) {
			t.Fatal("unexpected retries")
		}
		var generated struct {
			Agents []struct {
				Name   string `json:"name"`
				Format string `json:"model_api_format"`
			} `json:"agents"`
		}
		if err := json.Unmarshal(data, &generated); err != nil {
			t.Fatal(err)
		}
		if len(generated.Agents) != 1 || generated.Agents[0].Format != format || generated.Agents[0].Name != "terminus-2" {
			t.Fatalf("wrong agent config for %s: %+v", protocol, generated.Agents)
		}
	}
}
func TestRunPersistsResultsWithoutSecretsAndRejectsOverlap(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runner := &fakeRunner{ready: true, started: make(chan struct{}), gate: make(chan struct{})}
	root := t.TempDir()
	s, err := NewService(ctx, root, runner)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); s.Wait() })
	job, err := s.Start(context.Background(), fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	<-runner.started
	if _, err = s.Start(context.Background(), fixtureInput()); !errors.Is(err, ErrBusy) {
		t.Fatal("overlapping job accepted")
	}
	close(runner.gate)
	job = waitJob(t, s, job.ID)
	if job.Status != "completed_with_errors" || job.Trials[0].Status != "passed" || job.Trials[1].Status != "failed" || job.Trials[2].Status != "error" {
		t.Fatalf("results conflated: %+v", job.Trials)
	}
	data, err := os.ReadFile(filepath.Join(root, job.ID, "job.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "fixture-secret") || strings.Contains(string(data), "NetworkError") {
		t.Fatal("raw provider errors leaked into public history")
	}
	restored, err := NewService(ctx, root, runner)
	if err != nil {
		t.Fatal(err)
	}
	item, err := restored.Get(job.ID)
	if err != nil || item.Status != job.Status {
		t.Fatal("history not restored")
	}
}
func TestCancelAndUnavailable(t *testing.T) {
	runner := &fakeRunner{ready: false, started: make(chan struct{}), gate: make(chan struct{})}
	s, err := NewService(context.Background(), t.TempDir(), runner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Start(context.Background(), fixtureInput()); !errors.Is(err, ErrUnavailable) || runner.calls.Load() != 0 {
		t.Fatal("ran without prerequisites")
	}
	runner.ready = true
	job, err := s.Start(context.Background(), fixtureInput())
	if err != nil {
		t.Fatal(err)
	}
	<-runner.started
	if err = s.Cancel(job.ID); err != nil {
		t.Fatal(err)
	}
	job = waitJob(t, s, job.ID)
	if job.Status != "cancelled" {
		t.Fatalf("status %s", job.Status)
	}
	s.Wait()
}
func TestEnvironmentFiltersApplicationSecrets(t *testing.T) {
	t.Setenv("APP_LOGIN_KEY", "app-secret")
	t.Setenv("OPENAI_API_KEY", "other-key")
	env := strings.Join(runtimeEnv("fixture-secret"), "\n")
	if strings.Contains(env, "app-secret") || strings.Contains(env, "other-key") || !strings.Contains(env, "TB_MODEL_API_KEY=fixture-secret") || !strings.Contains(env, "HARBOR_TELEMETRY=0") {
		t.Fatal("unsafe subprocess environment")
	}
}
