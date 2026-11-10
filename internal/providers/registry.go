package providers

import (
	"fmt"
	"sort"

	"llm-intelligence/pkg/provider"
)

type Descriptor struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Registry is populated at startup and read only while serving requests.
type Registry struct{ items map[string]provider.Provider }

func NewRegistry() *Registry { return &Registry{items: make(map[string]provider.Provider)} }

func (r *Registry) Register(item provider.Provider) error {
	if _, exists := r.items[item.ID()]; exists {
		return fmt.Errorf("duplicate provider: %s", item.ID())
	}
	r.items[item.ID()] = item
	return nil
}

func (r *Registry) Get(id string) (provider.Provider, bool) { item, ok := r.items[id]; return item, ok }

func (r *Registry) List() []Descriptor {
	items := make([]Descriptor, 0, len(r.items))
	for _, item := range r.items {
		items = append(items, Descriptor{ID: item.ID(), Name: item.Name()})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	return items
}
