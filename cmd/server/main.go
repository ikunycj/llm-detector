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

	"llm-intelligence/internal/auth"
	"llm-intelligence/internal/config"
	"llm-intelligence/internal/evaluators"
	"llm-intelligence/internal/evaluators/smoke"
	"llm-intelligence/internal/httpapi"
	"llm-intelligence/internal/providers"
	"llm-intelligence/internal/scan"
	"llm-intelligence/internal/store"
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
	e := evaluators.NewRegistry()
	if err := e.Register(smoke.Engine{}); err != nil {
		return err
	}
	scans := scan.NewService(ctx, p, e, store.NewMemory())
	handler := httpapi.NewServer(auth.NewService(cfg.LoginKey, cfg.SessionTTL), p, e, scans, cfg.WebDist)
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
	scans.Wait()
	return err
}
