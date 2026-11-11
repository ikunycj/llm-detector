// Package application assembles the same engines for cloud and loopback runtimes.
package application

import (
	"context"
	"net/http"

	"llm-detector/internal/config"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/evaluators/fingerprint"
	benchevaluator "llm-detector/internal/evaluators/terminalbench"
	"llm-detector/internal/httpapi"
	"llm-detector/internal/inspection"
	"llm-detector/internal/projects/newapi"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/terminalbench"
)

type Runtime struct {
	Handler    http.Handler
	Scans      *scan.Service
	Inspection *inspection.Service
	Bench      *terminalbench.Service
}

func New(ctx context.Context, cfg config.Config, root string, scans scan.Store, projects inspection.Store, state inspection.State, benchStore terminalbench.Store, local bool) (*Runtime, error) {
	runner, err := terminalbench.NewHarborRunner(cfg.TerminalBenchBinary, "0.25.0")
	if err != nil {
		return nil, err
	}
	bench, err := terminalbench.NewServiceWithStore(ctx, root, runner, benchStore, local)
	if err != nil {
		return nil, err
	}
	p := providers.NewRegistry()
	if err = p.Register(providers.NewOpenAICompatible(cfg.RequestTimeout)); err != nil {
		return nil, err
	}
	e := evaluators.NewRegistry()
	if err = e.Register(fingerprint.New(cfg.FingerprintDataSource, cfg.FingerprintCachePath, cfg.FingerprintRequestTimeout)); err != nil {
		return nil, err
	}
	if err = e.Register(benchevaluator.New(bench)); err != nil {
		return nil, err
	}
	scanner := scan.NewService(ctx, p, e, scans)
	if local {
		for id, record := range state.Projects {
			record.View.Plan.Enabled = false
			record.View.NextRunAt = nil
			state.Projects[id] = record
		}
	}
	jobs, err := inspection.NewService(ctx, projects, state, scanner, e, newapi.Adapter{Timeout: cfg.RequestTimeout})
	if err != nil {
		return nil, err
	}
	if !local {
		jobs.Serve()
	}
	return &Runtime{Handler: httpapi.NewServer(nil, p, e, scanner, "", jobs, bench), Scans: scanner, Inspection: jobs, Bench: bench}, nil
}
func (r *Runtime) Wait() { r.Inspection.Wait(); r.Scans.Wait(); r.Bench.Wait() }
func Catalog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	catalog, err := terminalbench.LoadCatalog()
	if err != nil {
		http.Error(w, "catalog unavailable", 500)
		return
	}
	writeCatalog(w, catalog)
}
