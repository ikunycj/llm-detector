package terminalbench

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	bench "llm-detector/internal/terminalbench"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/provider"
)

type fakeJobs struct {
	input     bench.Input
	job       bench.Job
	startErr  error
	cancelled string
}

func (f *fakeJobs) Start(_ context.Context, input bench.Input) (bench.Job, error) {
	f.input = input
	return f.job, f.startErr
}
func (f *fakeJobs) Get(string) (bench.Job, error) { return f.job, nil }
func (f *fakeJobs) Cancel(id string) error        { f.cancelled = id; return nil }

func TestOptionsDefaultsAndValidation(t *testing.T) {
	for _, raw := range []json.RawMessage{nil, json.RawMessage(`{}`)} {
		suite, concurrency, err := parseOptions(raw)
		if err != nil || suite != "daily" || concurrency != 1 {
			t.Fatalf("defaults: %s %d %v", suite, concurrency, err)
		}
	}
	for _, raw := range []string{`null`, `[]`, `{} {}`, `{"suite":null}`, `{"suite":"other"}`, `{"concurrency":null}`, `{"concurrency":0}`, `{"concurrency":5}`, `{"concurrency":1.5}`, `{"concurrency":"2"}`, `{"unknown":true}`} {
		if _, _, err := parseOptions(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted invalid options %s", raw)
		}
	}
}

func TestRunPassesModelCredentialsAndPreservesVerifierOutcomes(t *testing.T) {
	pass, fail := 1.0, 0.0
	jobs := &fakeJobs{job: bench.Job{ID: "tb-fixture", Suite: "full", Dataset: "terminal-bench@2.0", Agent: "terminus-2", Status: "completed_with_errors", Trials: []bench.Trial{
		{Name: "passed-task", Status: "passed", Reward: &pass},
		{Name: "failed-task", Status: "failed", Reward: &fail},
		{Name: "error-task", Status: "error", Error: "运行异常"},
	}}}
	report, err := New(jobs).Run(context.Background(), evaluator.Target{
		Model:      provider.Model{ID: "selected-model"},
		Connection: provider.Connection{BaseURL: "https://fixture.invalid/v1", APIKey: "fixture-key", Protocol: "messages"},
		Options:    json.RawMessage(`{"suite":"full","concurrency":2}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if jobs.input.Model != "selected-model" || jobs.input.APIKey != "fixture-key" || jobs.input.Protocol != "messages" || jobs.input.BaseURL != "https://fixture.invalid/v1" || jobs.input.Suite != "full" || jobs.input.Concurrency != 2 {
		t.Fatal("model connection or options were not forwarded")
	}
	if report.Kind != ID || len(report.Checks) != 3 || report.Checks[0].Status != "passed" || report.Checks[1].Status != "failed" || report.Checks[2].Status != "error" {
		t.Fatalf("lost verifier outcomes: %+v", report.Checks)
	}
	if strings.Contains(string(report.Details), "fixture-key") {
		t.Fatal("credential leaked")
	}
	var result bench.Job
	if err := json.Unmarshal(report.Details, &result); err != nil || result.ID != "tb-fixture" {
		t.Fatal("missing standalone job reference")
	}
}

func TestRunReportsUnavailableBusyAndCancelledJobs(t *testing.T) {
	for _, reason := range []error{bench.ErrUnavailable, bench.ErrBusy} {
		if _, err := New(&fakeJobs{startErr: reason}).Run(context.Background(), evaluator.Target{}); !errors.Is(err, reason) {
			t.Fatalf("lost start error: %v", err)
		}
	}
	jobs := &fakeJobs{job: bench.Job{ID: "tb-cancel", Status: "running"}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New(jobs).Run(ctx, evaluator.Target{}); !errors.Is(err, context.Canceled) || jobs.cancelled != "tb-cancel" {
		t.Fatal("cancelled scan left its Harbor job running")
	}
	jobs = &fakeJobs{job: bench.Job{ID: "tb-cancelled", Status: "cancelled", Error: "用户已取消", Trials: []bench.Trial{{Name: "unfinished", Status: "cancelled"}}}}
	report, err := New(jobs).Run(context.Background(), evaluator.Target{})
	if err != nil || report.Error == "" || report.Checks[0].Status != "error" {
		t.Fatal("incomplete job treated as a completed capability result")
	}
}

func TestOrganizationIsNotSilentlyDiscarded(t *testing.T) {
	jobs := &fakeJobs{}
	_, err := New(jobs).Run(context.Background(), evaluator.Target{Connection: provider.Connection{Organization: "org-fixture"}})
	if err == nil || !strings.Contains(err.Error(), "Organization") || jobs.input.Model != "" {
		t.Fatal("unsupported organization ignored")
	}
}
