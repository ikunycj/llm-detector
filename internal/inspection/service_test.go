package inspection

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"llm-detector/internal/evaluators"
	"llm-detector/internal/evaluators/smoke"
	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/project"
	"llm-detector/pkg/provider"
)

type fixtureAdapter struct{ base, organization string }

func (f *fixtureAdapter) ID() string { return "newapi" }
func (f *fixtureAdapter) Discover(context.Context, project.Connection) ([]project.Channel, error) {
	return []project.Channel{
		{ID: "1", Name: "upstream-1", Groups: []string{"vip"}, BaseURL: f.base, Protocol: "messages", Organization: f.organization, Models: []string{"model-a"}, Enabled: true},
		{ID: "2", Name: "upstream-2", Groups: []string{"basic"}, BaseURL: f.base, Protocol: "chat_completions", Models: []string{"model-b"}, Enabled: true},
	}, nil
}
func (f *fixtureAdapter) ImportKeys(_ context.Context, _ project.Connection, channels []project.Channel, _ string) (map[string]string, map[string]string, error) {
	keys := map[string]string{}
	for _, ch := range channels {
		keys[ch.ID] = "fixture-upstream-secret"
	}
	return keys, map[string]string{}, nil
}

type fixtureRunner struct {
	mu       sync.Mutex
	requests []scan.Request
	scans    map[string]scan.Scan
	gate     chan struct{}
	started  chan struct{}
}

func (f *fixtureRunner) Start(req scan.Request) (scan.Scan, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.requests = append(f.requests, req)
	id, err := newID("scan")
	if err != nil {
		return scan.Scan{}, err
	}
	item := scan.Scan{ID: id, Status: "running", Models: []scan.ModelResult{{Model: provider.Model{ID: req.Models[0], Name: req.Models[0]}, Status: "completed", Report: evaluator.Report{Checks: []evaluator.Check{{ID: "check", Status: "passed"}}}}}}
	f.scans[id] = item
	select {
	case f.started <- struct{}{}:
	default:
	}
	return item, nil
}
func (f *fixtureRunner) Get(id string) (scan.Scan, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	item := f.scans[id]
	select {
	case <-f.gate:
		item.Status = "completed"
	default:
	}
	return item, nil
}

func setupService(t *testing.T) (*Service, *fixtureAdapter, *fixtureRunner, string) {
	t.Helper()
	dir := t.TempDir()
	file, state, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	e := evaluators.NewRegistry()
	if err := e.Register(smoke.Engine{}); err != nil {
		t.Fatal(err)
	}
	if err := e.Register(fixtureFingerprint{}); err != nil {
		t.Fatal(err)
	}
	r := &fixtureRunner{scans: map[string]scan.Scan{}, gate: make(chan struct{}), started: make(chan struct{}, 20)}
	a := &fixtureAdapter{base: "http://upstream.invalid/v1"}
	s, err := NewService(ctx, file, state, r, e, a)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); s.Wait() })
	return s, a, r, dir
}

type fixtureFingerprint struct{}

func (fixtureFingerprint) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{ID: "fingerprint", Name: "fixture"}
}
func (fixtureFingerprint) Run(context.Context, evaluator.Target) (evaluator.Report, error) {
	return evaluator.Report{}, nil
}
func (fixtureFingerprint) ValidateOptions(raw json.RawMessage) error {
	var v map[string]any
	if json.Unmarshal(raw, &v) != nil || (v["api"] != "messages" && v["api"] != "chat_completions" && v["api"] != "responses") {
		return errors.New("protocol lost")
	}
	return nil
}

func configureService(t *testing.T, s *Service) Project {
	t.Helper()
	p, err := s.SaveProject("", Input{Name: "New API fixture", Kind: "newapi", BaseURL: "http://newapi.invalid", UserID: 1, AccessToken: "fixture-admin-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Sync(context.Background(), p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.ImportKeys(context.Background(), p.ID, []string{"1"}, "123456"); err != nil {
		t.Fatal(err)
	}
	p, err = s.UpdatePlan(p.ID, Plan{Mode: "groups", Groups: []string{"vip"}, Evaluators: []string{"smoke", "fingerprint"}, IntervalMinutes: 1, Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestNewProjectUsesRegisteredDefaultEvaluators(t *testing.T) {
	dir := t.TempDir()
	file, state, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	e := evaluators.NewRegistry()
	if err := e.Register(registryPlanEngine{descriptor: evaluator.Descriptor{ID: "custom-default", Name: "Custom default", Default: true}}); err != nil {
		t.Fatal(err)
	}
	if err := e.Register(registryPlanEngine{descriptor: evaluator.Descriptor{ID: "custom-extra", Name: "Custom extra"}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s, err := NewService(ctx, file, state, nil, e, &fixtureAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Wait()
	p, err := s.SaveProject("", Input{Name: "dynamic evaluators", Kind: "newapi", BaseURL: "http://newapi.invalid", UserID: 1, AccessToken: "fixture-admin-secret"})
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Plan.Evaluators) != 1 || p.Plan.Evaluators[0] != "custom-default" {
		t.Fatalf("new project evaluators=%v, want [custom-default]", p.Plan.Evaluators)
	}
}

type registryPlanEngine struct{ descriptor evaluator.Descriptor }

func (e registryPlanEngine) Descriptor() evaluator.Descriptor { return e.descriptor }
func (registryPlanEngine) Run(context.Context, evaluator.Target) (evaluator.Report, error) {
	return evaluator.Report{}, nil
}
func waitFinished(t *testing.T, s *Service, id string) Run {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		runs, err := s.Runs("")
		if err != nil {
			t.Fatal(err)
		}
		for _, r := range runs {
			if r.ID == id && r.Status != "running" {
				return r
			}
		}
		select {
		case <-deadline.C:
			t.Fatal("batch did not complete")
		case <-ticker.C:
		}
	}
}

func TestScheduledBatchIsSerializedAndCredentialsStayServerSide(t *testing.T) {
	s, _, runner, dir := setupService(t)
	p := configureService(t, s)
	s.Tick(p.NextRunAt.Add(time.Second))
	select {
	case <-runner.started:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduled scan not started")
	}
	if _, err := s.Run(p.ID, "manual"); !errors.Is(err, ErrBusy) {
		t.Fatalf("overlap allowed: %v", err)
	}
	if err := s.Delete(p.ID); !errors.Is(err, ErrBusy) {
		t.Fatalf("deleted running project: %v", err)
	}
	s.Tick(p.NextRunAt.Add(time.Minute))
	runs, err := s.Runs(p.ID)
	if err != nil || len(runs) != 1 {
		t.Fatal("scheduler duplicated a running batch")
	}
	if len(runs[0].Items) != 2 {
		t.Fatal("group filtering or multi-engine expansion incorrect")
	}
	close(runner.gate)
	finished := waitFinished(t, s, runs[0].ID)
	if finished.Status != "completed" || finished.Items[0].Result == nil || finished.Items[1].Result == nil {
		t.Fatalf("result snapshots missing: %+v", finished)
	}
	runner.mu.Lock()
	requests := append([]scan.Request{}, runner.requests...)
	runner.mu.Unlock()
	if len(requests) != 2 || requests[0].Connection.APIKey != "fixture-upstream-secret" || requests[1].Connection.Protocol != "messages" {
		t.Fatal("channel credentials or protocol lost")
	}
	p, err = s.Get(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	public, _ := json.Marshal(p)
	if strings.Contains(string(public), "fixture-admin-secret") || strings.Contains(string(public), "fixture-upstream-secret") {
		t.Fatal("project response leaked secrets")
	}
	data, err := os.ReadFile(filepath.Join(dir, "inspections.enc"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "fixture-admin-secret") || strings.Contains(string(data), "fixture-upstream-secret") {
		t.Fatal("store not encrypted")
	}
	_, restored, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Projects[p.ID].Keys["1"] != "fixture-upstream-secret" || restored.Runs[0].Items[0].Result == nil {
		t.Fatal("credentials or results did not survive reload")
	}
}

func TestSyncInvalidatesKeysWhenUpstreamChanges(t *testing.T) {
	s, a, _, _ := setupService(t)
	p := configureService(t, s)
	a.base = "http://changed.invalid/v1"
	p, err := s.Sync(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if p.Channels[0].HasKey {
		t.Fatal("old key would be sent to changed host")
	}
	if _, err = s.SaveProject(p.ID, Input{Name: p.Name, Kind: p.Kind, BaseURL: "http://changed-newapi.invalid", UserID: 1}); !errors.Is(err, ErrInvalid) {
		t.Fatal("reused access token on changed project URL")
	}
}

func TestManualBatchPersistsMissingKeyFailures(t *testing.T) {
	s, _, _, _ := setupService(t)
	p, err := s.SaveProject("", Input{Name: "fixture", Kind: "newapi", BaseURL: "http://newapi.invalid", UserID: 1, AccessToken: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Sync(context.Background(), p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.UpdatePlan(p.ID, Plan{Mode: "all", Evaluators: []string{"smoke"}, IntervalMinutes: 60}); err != nil {
		t.Fatal(err)
	}
	run, err := s.Run(p.ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	run = waitFinished(t, s, run.ID)
	if run.Status != "completed_with_errors" || len(run.Items) != 2 || run.Items[0].Error == "" {
		t.Fatal("missing key failure masked")
	}
}

func TestRestoreMarksInterruptedAndDoesNotCatchUp(t *testing.T) {
	dir := t.TempDir()
	file, state, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	state.Projects["p"] = diskProject{View: Project{ID: "p", Plan: Plan{Enabled: true, IntervalMinutes: 5}, NextRunAt: &past}, Keys: map[string]string{}}
	state.Runs = []Run{{ID: "r", ProjectID: "p", Status: "running", Items: []RunItem{{Status: "running"}}}}
	if err = file.Save(state); err != nil {
		t.Fatal(err)
	}
	s, err := NewService(context.Background(), file, state, nil, evaluators.NewRegistry(), &fixtureAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	runs, err := s.Runs("p")
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Get("p")
	if err != nil {
		t.Fatal(err)
	}
	if runs[0].Status != "interrupted" || runs[0].Items[0].Status != "interrupted" || !p.NextRunAt.After(time.Now()) {
		t.Fatal("restart recovery incorrect")
	}
}

func TestMissingEncryptionKeyDoesNotReplaceStore(t *testing.T) {
	dir := t.TempDir()
	file, state, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = file.Save(state); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(dir, "inspection.key")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := OpenStore(dir); err == nil {
		t.Fatal("created replacement key for existing encrypted data")
	}
	if _, err := os.Stat(filepath.Join(dir, "inspection.key")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("key was unexpectedly regenerated")
	}
}

func (f *fixtureAdapter) ResolveUserID(_ context.Context, _ project.Connection, account, password, code string) (int, error) {
	if account != "admin@example.com" || password != "fixture-password" || code != "123456" {
		return 0, errors.New("invalid login fixture")
	}
	return 8, nil
}
func TestAccountIdentityNotPasswordIsPersisted(t *testing.T) {
	s, _, _, dir := setupService(t)
	p, err := s.SaveConnection(context.Background(), "", Input{Name: "account fixture", Kind: "newapi", BaseURL: "http://newapi.invalid", AccessToken: "fixture-admin-token", AdminAccount: "admin@example.com", Password: "fixture-password", LoginCode: "123456"})
	if err != nil || p.UserID != 8 || p.AdminAccount != "admin@example.com" {
		t.Fatalf("account resolve: %+v %v", p, err)
	}
	_, state, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	serialized, _ := json.Marshal(state)
	if strings.Contains(string(serialized), "fixture-password") || strings.Contains(string(serialized), "123456") {
		t.Fatal("login credentials persisted")
	}
	p, err = s.SaveConnection(context.Background(), p.ID, Input{Name: "renamed", Kind: p.Kind, BaseURL: p.BaseURL, AdminAccount: p.AdminAccount})
	if err != nil || p.UserID != 8 {
		t.Fatal("editing name required password again")
	}
}
func TestCombinedSyncImportsKeys(t *testing.T) {
	s, _, _, _ := setupService(t)
	p, err := s.SaveProject("", Input{Name: "fixture", Kind: "newapi", BaseURL: "http://newapi.invalid", UserID: 1, AccessToken: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	p, err = s.SyncAndImport(context.Background(), p.ID, "123456")
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Channels) != 2 || !p.Channels[0].HasKey || !p.Channels[1].HasKey {
		t.Fatal("combined sync did not import all usable keys")
	}
	data, _ := json.Marshal(p)
	if strings.Contains(string(data), "fixture-upstream-secret") {
		t.Fatal("key exposed to client")
	}
}

func TestMergeChannelsDefaultsUnknownProtocolToChatCompletions(t *testing.T) {
	raw := diskProject{View: Project{Channels: []ChannelView{}}, Keys: map[string]string{}}
	merged := mergeChannels(raw, []project.Channel{{ID: "unknown", Name: "unknown", BaseURL: "https://upstream.invalid/v1", Models: []string{"model"}, Enabled: true}})
	if len(merged.View.Channels) != 1 || merged.View.Channels[0].ProtocolOverride != "chat_completions" {
		t.Fatalf("unknown protocol did not get the default override: %+v", merged.View.Channels)
	}
}

func TestChannelProtocolOverridePersistsAcrossSyncAndAppliesToEveryEngine(t *testing.T) {
	s, adapter, runner, dir := setupService(t)
	adapter.organization = "org-fixture"
	p := configureService(t, s)
	p, err := s.UpdateChannelProtocol(p.ID, "1", "chat_completions")
	if err != nil {
		t.Fatal(err)
	}
	if p.Channels[0].Protocol != "messages" || p.Channels[0].ProtocolOverride != "chat_completions" || !p.Channels[0].HasKey {
		t.Fatal("protocol edit changed discovered metadata or discarded credentials")
	}
	p, err = s.Sync(context.Background(), p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if p.Channels[0].ProtocolOverride != "chat_completions" || !p.Channels[0].HasKey || p.Channels[0].Organization != "org-fixture" {
		t.Fatal("sync lost protocol override, credentials or organization")
	}
	_, restored, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Projects[p.ID].View.Channels[0].ProtocolOverride != "chat_completions" {
		t.Fatal("override was not persisted")
	}
	close(runner.gate)
	run, err := s.Run(p.ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	run = waitFinished(t, s, run.ID)
	if run.Status != "completed" || len(run.Items) != 2 {
		t.Fatalf("run=%+v", run)
	}
	runner.mu.Lock()
	requests := append([]scan.Request(nil), runner.requests...)
	runner.mu.Unlock()
	for _, req := range requests {
		if req.Connection.Protocol != "chat_completions" || req.Connection.Organization != "org-fixture" {
			t.Fatal("runner ignored test protocol or organization")
		}
		if req.Evaluator == "fingerprint" {
			var options map[string]any
			if json.Unmarshal(req.Options, &options) != nil || options["api"] != "chat_completions" {
				t.Fatal("fingerprint used discovered protocol instead of override")
			}
		}
	}
	for _, item := range run.Items {
		if item.Protocol != "chat_completions" {
			t.Fatal("batch did not snapshot test protocol")
		}
	}
	s.Wait()
	p, err = s.UpdateChannelProtocol(p.ID, "1", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Channels[0].ProtocolOverride != "" || p.Channels[0].Protocol != "messages" {
		t.Fatal("follow-channel option did not clear override")
	}
	if _, err = s.UpdateChannelProtocol(p.ID, "1", "invalid"); !errors.Is(err, ErrInvalid) {
		t.Fatal("unsupported protocol accepted")
	}
	p, err = s.UpdateChannelProtocol(p.ID, "1", "responses")
	if err != nil || p.Channels[0].ProtocolOverride != "responses" {
		t.Fatalf("responses protocol override rejected: %+v %v", p, err)
	}
	if _, err = s.UpdateChannelProtocol(p.ID, "missing", "messages"); !errors.Is(err, ErrInvalid) {
		t.Fatal("unknown channel accepted")
	}
}

func TestRemovedEnginePausesPlanWithoutSubstitutingAnother(t *testing.T) {
	dir := t.TempDir()
	file, data, err := OpenStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	data.Projects["legacy"] = diskProject{View: Project{ID: "legacy", Plan: Plan{Mode: "all", Evaluators: []string{"smoke"}, Enabled: true, IntervalMinutes: 60}}, Keys: map[string]string{}}
	registry := evaluators.NewRegistry()
	if err := registry.Register(fixtureFingerprint{}); err != nil {
		t.Fatal(err)
	}
	s, err := NewService(context.Background(), file, data, nil, registry, &fixtureAdapter{})
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Get("legacy")
	if err != nil || p.Plan.Enabled || p.NextRunAt != nil || p.LastError == "" || len(p.Plan.Evaluators) != 1 || p.Plan.Evaluators[0] != "smoke" {
		t.Fatalf("legacy plan was silently substituted: %+v %v", p, err)
	}
	if _, err := s.Run("legacy", "manual"); !errors.Is(err, ErrInvalid) {
		t.Fatal("removed engine started a batch")
	}
	_, restored, err := OpenStore(dir)
	if err != nil || restored.Projects["legacy"].View.Plan.Enabled {
		t.Fatal("disabled schedule was not persisted")
	}
}

func TestPlanOptionsAreValidatedAndSnapshotsDoNotAlias(t *testing.T) {
	s, _, _, _ := setupService(t)
	p := configureService(t, s)
	plan := p.Plan
	plan.Evaluators = []string{"fingerprint"}
	for _, options := range []map[string]json.RawMessage{
		{"unknown": json.RawMessage(`{}`)},
		{"fingerprint": json.RawMessage(`null`)},
		{"fingerprint": json.RawMessage(`[]`)},
		{"fingerprint": json.RawMessage(`{"api":"invalid"}`)},
	} {
		plan.EvaluatorOptions = options
		if _, err := s.UpdatePlan(p.ID, plan); !errors.Is(err, ErrInvalid) {
			t.Fatal("invalid engine configuration accepted")
		}
	}
	plan.EvaluatorOptions = map[string]json.RawMessage{"fingerprint": json.RawMessage(`{"api":"messages"}`)}
	if _, err := s.UpdatePlan(p.ID, plan); err != nil {
		t.Fatal(err)
	}
	saved, err := s.Get(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved.Plan.EvaluatorOptions["fingerprint"][0] = '!'
	readback, err := s.Get(p.ID)
	if err != nil || string(readback.Plan.EvaluatorOptions["fingerprint"]) != `{"api":"messages"}` {
		t.Fatal("API snapshot mutated persisted engine settings")
	}
}
