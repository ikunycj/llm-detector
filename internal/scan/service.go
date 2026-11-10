package scan

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"llm-intelligence/internal/evaluators"
	"llm-intelligence/internal/providers"
	"llm-intelligence/pkg/evaluator"
	"llm-intelligence/pkg/provider"
)

type Service struct {
	ctx       context.Context
	providers *providers.Registry
	engines   *evaluators.Registry
	store     Store
	workers   sync.WaitGroup
}

func NewService(ctx context.Context, p *providers.Registry, e *evaluators.Registry, store Store) *Service {
	return &Service{ctx: ctx, providers: p, engines: e, store: store}
}

func (s *Service) Start(request Request) (Scan, error) {
	adapter, ok := s.providers.Get(request.Vendor)
	if !ok {
		return Scan{}, errors.New("unknown provider")
	}
	engine, ok := s.engines.Get(request.Evaluator)
	if !ok {
		return Scan{}, errors.New("unknown evaluator")
	}
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return Scan{}, fmt.Errorf("create scan ID: %w", err)
	}
	item := Scan{ID: "scan-" + hex.EncodeToString(buffer), Status: "pending", Vendor: request.Vendor, Evaluator: engine.Descriptor(), Scope: request.Scope, Models: []ModelResult{}, CreatedAt: time.Now().UTC()}
	s.store.Save(item)
	s.workers.Go(func() { s.run(request, item, adapter, engine) })
	return item, nil
}

// Wait is called after the HTTP server stops accepting new tasks.
func (s *Service) Wait()                       { s.workers.Wait() }
func (s *Service) Get(id string) (Scan, error) { return s.store.Get(id) }
func (s *Service) List() []Scan                { return s.store.List() }

func (s *Service) run(request Request, item Scan, adapter provider.Provider, engine evaluator.Engine) {
	now := time.Now().UTC()
	item.Status, item.StartedAt = "running", &now
	s.store.Save(item)
	finish := func(status string, err error) {
		item.Status = status
		if err != nil {
			item.Error = redact(err.Error(), request.Connection.APIKey)
		}
		done := time.Now().UTC()
		item.CompletedAt = &done
		s.store.Save(item)
	}
	models := make([]provider.Model, 0, len(request.Models))
	if request.Scope == "all" {
		var err error
		models, err = adapter.DiscoverModels(s.ctx, request.Connection)
		if err != nil {
			finish("failed", err)
			return
		}
	} else {
		for _, id := range request.Models {
			models = append(models, provider.Model{ID: id, Name: id})
		}
	}
	if len(models) == 0 {
		finish("failed", errors.New("no models to scan"))
		return
	}
	for _, model := range models {
		item.Models = append(item.Models, ModelResult{Model: model, Status: "pending", Report: evaluator.Report{Checks: []evaluator.Check{}}})
	}
	s.store.Save(item)
	hasErrors := false
	for i, model := range models {
		if err := s.ctx.Err(); err != nil {
			finish("failed", err)
			return
		}
		item.Models[i].Status = "running"
		s.store.Save(item)
		report, err := engine.Run(s.ctx, evaluator.Target{Provider: adapter, Connection: request.Connection, Model: model})
		result := &item.Models[i]
		result.Status = "completed"
		if err != nil {
			result.Status = "error"
			result.Error = redact(err.Error(), request.Connection.APIKey)
			hasErrors = true
		}
		if err == nil && len(report.Checks) == 0 {
			result.Status = "error"
			result.Error = "evaluator returned no checks"
			hasErrors = true
		}
		for j := range report.Checks {
			check := &report.Checks[j]
			check.Output = redact(check.Output, request.Connection.APIKey)
			check.Error = redact(check.Error, request.Connection.APIKey)
			if check.Status == "error" {
				hasErrors = true
				result.Status = "error"
			}
		}
		result.Report = report
		s.store.Save(item)
	}
	if err := s.ctx.Err(); err != nil {
		finish("failed", err)
		return
	}
	status := "completed"
	if hasErrors {
		status = "completed_with_errors"
	}
	finish(status, nil)
}

// Keep bounded output evidence, after removing the submitted credential.
func redact(text, key string) string {
	text = strings.ReplaceAll(text, key, "[REDACTED]")
	runes := []rune(text)
	if len(runes) > 1000 {
		return string(runes[:1000]) + "…"
	}
	return text
}
