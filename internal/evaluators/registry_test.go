package evaluators

import (
	"context"
	"testing"

	"llm-detector/pkg/evaluator"
)

type registryTestEngine struct{ descriptor evaluator.Descriptor }

func (e registryTestEngine) Descriptor() evaluator.Descriptor { return e.descriptor }
func (registryTestEngine) Run(context.Context, evaluator.Target) (evaluator.Report, error) {
	return evaluator.Report{}, nil
}

func TestDefaultIDsUseRegisteredDescriptorMetadata(t *testing.T) {
	registry := NewRegistry()
	for _, descriptor := range []evaluator.Descriptor{
		{ID: "zeta", Name: "Zeta"},
		{ID: "alpha", Name: "Alpha", Default: true},
		{ID: "beta", Name: "Beta", Default: true},
	} {
		if err := registry.Register(registryTestEngine{descriptor: descriptor}); err != nil {
			t.Fatal(err)
		}
	}
	got := registry.DefaultIDs()
	want := []string{"alpha", "beta"}
	if len(got) != len(want) {
		t.Fatalf("DefaultIDs()=%v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("DefaultIDs()=%v, want %v", got, want)
		}
	}
}

func TestDefaultIDsDoesNotSelectUndeclaredDefaults(t *testing.T) {
	registry := NewRegistry()
	for _, id := range []string{"zeta", "alpha"} {
		if err := registry.Register(registryTestEngine{descriptor: evaluator.Descriptor{ID: id, Name: id}}); err != nil {
			t.Fatal(err)
		}
	}
	got := registry.DefaultIDs()
	if len(got) != 0 {
		t.Fatalf("DefaultIDs()=%v, want no implicit defaults", got)
	}
}
