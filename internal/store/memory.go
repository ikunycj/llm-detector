package store

import (
	"sort"
	"sync"

	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
)

type Memory struct {
	mu    sync.RWMutex
	scans map[string]scan.Scan
}

func NewMemory() *Memory { return &Memory{scans: make(map[string]scan.Scan)} }

func (s *Memory) Save(item scan.Scan) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scans[item.ID] = clone(item)
	return nil
}
func (s *Memory) Get(id string) (scan.Scan, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.scans[id]
	if !ok {
		return scan.Scan{}, scan.ErrNotFound
	}
	return clone(item), nil
}
func (s *Memory) List() ([]scan.Scan, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]scan.Scan, 0, len(s.scans))
	for _, item := range s.scans {
		items = append(items, clone(item))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items, nil
}
func clone(item scan.Scan) scan.Scan {
	item.Models = append([]scan.ModelResult{}, item.Models...)
	for i := range item.Models {
		item.Models[i].Report.Checks = append([]evaluator.Check{}, item.Models[i].Report.Checks...)
		item.Models[i].Report.Details = append([]byte(nil), item.Models[i].Report.Details...)
	}
	if item.StartedAt != nil {
		value := *item.StartedAt
		item.StartedAt = &value
	}
	if item.CompletedAt != nil {
		value := *item.CompletedAt
		item.CompletedAt = &value
	}
	return item
}
