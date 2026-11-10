package evaluators

import (
	"fmt"
	"sort"

	"llm-intelligence/pkg/evaluator"
)

// Registry is populated at startup and read only while serving requests.
type Registry struct{ engines map[string]evaluator.Engine }

func NewRegistry() *Registry { return &Registry{engines: make(map[string]evaluator.Engine)} }

func (r *Registry) Register(engine evaluator.Engine) error {
	id := engine.Descriptor().ID
	if _, exists := r.engines[id]; exists {
		return fmt.Errorf("duplicate evaluator: %s", id)
	}
	r.engines[id] = engine
	return nil
}

func (r *Registry) Get(id string) (evaluator.Engine, bool) {
	engine, ok := r.engines[id]
	return engine, ok
}

func (r *Registry) List() []evaluator.Descriptor {
	items := make([]evaluator.Descriptor, 0, len(r.engines))
	for _, engine := range r.engines {
		items = append(items, engine.Descriptor())
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}
