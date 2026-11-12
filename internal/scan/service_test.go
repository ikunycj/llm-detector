package scan_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"llm-detector/internal/evaluators"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/store"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/provider"
)

type structuredEngine struct{}

func (structuredEngine) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{ID: "structured"}
}
func (structuredEngine) ProviderIndependent() bool { return true }
func (structuredEngine) Run(context.Context, evaluator.Target) (evaluator.Report, error) {
	return evaluator.Report{Kind: "structured", Details: json.RawMessage(`{"sample":"fixture"}`)}, nil
}

// Capture JSON exactly as a persistent store sees it, before a store can normalize slices.
type captureStore struct {
	*store.Memory
	payloads []string
}

func (s *captureStore) Save(item scan.Scan) error {
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	s.payloads = append(s.payloads, string(raw))
	return s.Memory.Save(item)
}
func TestStructuredReportsAlwaysSerializeArrayChecks(t *testing.T) {
	engines := evaluators.NewRegistry()
	if err := engines.Register(structuredEngine{}); err != nil {
		t.Fatal(err)
	}
	memory := &captureStore{Memory: store.NewMemory()}
	service := scan.NewService(context.Background(), providers.NewRegistry(), engines, memory)
	_, err := service.Start(scan.Request{Evaluator: "structured", Scope: "selected", Models: []string{"fixture-model"}, Connection: provider.Connection{BaseURL: "https://unused.invalid", APIKey: "fixture"}})
	if err != nil {
		t.Fatal(err)
	}
	service.Wait()
	for _, payload := range memory.payloads {
		if strings.Contains(payload, `"checks":null`) {
			t.Fatal("null checks would break persisted reports after restart")
		}
	}
}
