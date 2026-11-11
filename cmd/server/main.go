package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"llm-detector/internal/auth"
	"llm-detector/internal/config"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/evaluators/fingerprint"
	benchevaluator "llm-detector/internal/evaluators/terminalbench"
	"llm-detector/internal/httpapi"
	"llm-detector/internal/inspection"
	"llm-detector/internal/projects/newapi"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/store"
	"llm-detector/internal/terminalbench"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if cfg.WebDist != "" {
		if _, err := os.Stat(filepath.Join(cfg.WebDist, "index.html")); err != nil {
			return errors.New("WEB_DIST_DIR must contain a built index.html")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// Composition root: optional SDK adapters are only wired here.
	p := providers.NewRegistry()
	if err := p.Register(providers.NewOpenAICompatible(cfg.RequestTimeout)); err != nil {
		return err
	}
	runner, err := terminalbench.NewHarborRunner(cfg.TerminalBenchBinary, "0.25.0")
	if err != nil {
		return err
	}
	bench, err := terminalbench.NewService(ctx, filepath.Join(cfg.DataDir, "terminal-bench"), runner)
	if err != nil {
		return err
	}
	defer func() { stop(); bench.Wait() }()
	e := evaluators.NewRegistry()
	if err := e.Register(benchevaluator.New(bench)); err != nil {
		return err
	}
	if err := e.Register(fingerprint.New(cfg.FingerprintDataSource, cfg.FingerprintCachePath, cfg.FingerprintRequestTimeout)); err != nil {
		return err
	}
	scans := scan.NewService(ctx, p, e, store.NewMemory())
	disk, state, err := inspection.OpenStore(cfg.DataDir)
	if err != nil {
		return err
	}
	jobs, err := inspection.NewService(ctx, disk, state, scans, e, newapi.Adapter{Timeout: cfg.RequestTimeout})
	if err != nil {
		return err
	}
	jobs.Serve()
	defer func() { stop(); jobs.Wait(); scans.Wait() }()
	handler := httpapi.NewServer(auth.NewService(cfg.LoginKey, cfg.SessionTTL), p, e, scans, cfg.WebDist, jobs, bench)
	server := &http.Server{Addr: cfg.Addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: cfg.RequestTimeout + 5*time.Second, IdleTimeout: 60 * time.Second}
	done := make(chan error, 1)
	go func() { log.Printf("listening on %s", cfg.Addr); done <- server.ListenAndServe() }()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	stop()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = server.Shutdown(shutdownCtx)
	return err
}
