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

	"llm-detector/internal/evaluators"
	"llm-detector/internal/providers"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/provider"
)

type Service struct {
	ctx       context.Context
	providers *providers.Registry
	engines   *evaluators.Registry
	store     Store
	workers   sync.WaitGroup
	faultMu   sync.Mutex
	fault     error
}

func NewService(ctx context.Context, p *providers.Registry, e *evaluators.Registry, store Store) *Service {
	return &Service{ctx: ctx, providers: p, engines: e, store: store}
}

func (s *Service) Start(request Request) (Scan, error) {
	engine, ok := s.engines.Get(request.Evaluator)
	if !ok {
		return Scan{}, errors.New("unknown evaluator")
	}
	independent, isIndependent := engine.(evaluator.ProviderIndependent)
	providerIndependent := isIndependent && independent.ProviderIndependent()
	adapter, ok := s.providers.Get(request.Vendor)
	if !ok && !providerIndependent {
		return Scan{}, errors.New("unknown provider")
	}
	if request.Scope == "all" && !ok {
		return Scan{}, errors.New("selected provider is required to discover all models")
	}
	serviceName := strings.TrimSpace(request.ServiceName)
	if serviceName == "" {
		serviceName = request.Connection.BaseURL
	}
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return Scan{}, fmt.Errorf("create scan ID: %w", err)
	}
	item := Scan{ID: "scan-" + hex.EncodeToString(buffer), Status: "pending", Vendor: request.Vendor, ServiceName: serviceName, Evaluator: engine.Descriptor(), Scope: request.Scope, Models: []ModelResult{}, CreatedAt: time.Now().UTC()}
	if err := s.store.Save(item); err != nil {
		return Scan{}, err
	}
	s.workers.Go(func() { s.run(request, item, adapter, engine) })
	return item, nil
}

// Wait is called after the HTTP server stops accepting new tasks.
func (s *Service) Wait() { s.workers.Wait() }
func (s *Service) Get(id string) (Scan, error) {
	s.faultMu.Lock()
	err := s.fault
	s.faultMu.Unlock()
	if err != nil {
		return Scan{}, err
	}
	return s.store.Get(id)
}
func (s *Service) List() ([]Scan, error) {
	s.faultMu.Lock()
	err := s.fault
	s.faultMu.Unlock()
	if err != nil {
		return nil, err
	}
	return s.store.List()
}
func (s *Service) persist(item Scan) bool {
	if err := s.store.Save(item); err != nil {
		s.faultMu.Lock()
		s.fault = errors.New("扫描结果保存失败，请检查存储")
		s.faultMu.Unlock()
		return false
	}
	return true
}

func (s *Service) run(request Request, item Scan, adapter provider.Provider, engine evaluator.Engine) {
	now := time.Now().UTC()
	item.Status, item.StartedAt = "running", &now
	if !s.persist(item) {
		return
	}
	finish := func(status string, err error) {
		item.Status = status
		if err != nil {
			item.Error = redact(err.Error(), request.Connection.APIKey)
		}
		done := time.Now().UTC()
		item.CompletedAt = &done
		if !s.persist(item) {
			return
		}
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
	if !s.persist(item) {
		return
	}
	hasErrors := false
	for i, model := range models {
		if err := s.ctx.Err(); err != nil {
			finish("failed", err)
			return
		}
		item.Models[i].Status = "running"
		if !s.persist(item) {
			return
		}
		report, err := engine.Run(s.ctx, evaluator.Target{Provider: adapter, Connection: request.Connection, Model: model, Options: request.Options})
		result := &item.Models[i]
		result.Status = "completed"
		if err != nil {
			result.Status = "error"
			result.Error = redact(err.Error(), request.Connection.APIKey)
			hasErrors = true
		}
		if err == nil && report.Error != "" {
			result.Status = "error"
			result.Error = redact(report.Error, request.Connection.APIKey)
			hasErrors = true
		}
		if err == nil && len(report.Checks) == 0 && report.Kind == "" {
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
		if !s.persist(item) {
			return
		}
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
