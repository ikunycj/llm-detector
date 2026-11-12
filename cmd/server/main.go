package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"llm-detector/internal/application"
	"llm-detector/internal/cloud"
	"llm-detector/internal/config"
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
	cfg.CloudAdminUsername = strings.ToLower(strings.TrimSpace(cfg.CloudAdminUsername))
	if cfg.CloudLoginKey == "" {
		return errors.New("请在 .env 配置 APP_LOGIN_KEY，或运行 make init-env")
	}
	if cfg.WebDist != "" {
		if _, err := os.Stat(filepath.Join(cfg.WebDist, "index.html")); err != nil {
			return errors.New("WEB_DIST_DIR must contain a built index.html")
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, err := cloud.Open(cfg.DataDir)
	if err != nil {
		return err
	}
	defer db.Close()
	users, err := db.Users()
	if err != nil {
		return err
	}
	if len(users) == 0 {
		if _, err = db.CreateUser(cfg.CloudAdminUsername, cfg.CloudAdminPassword); err != nil {
			return errors.New("请在 .env 配置 CLOUD_ADMIN_USERNAME 和 CLOUD_ADMIN_PASSWORD，或运行 make init-env")
		}
	}
	// Existing deployments keep their account IDs and data. Reject a mistyped owner
	// instead of authenticating a key into a different or empty workspace.
	users, err = db.Users()
	if err != nil {
		return err
	}
	found := false
	for _, user := range users {
		if user.Username == cfg.CloudAdminUsername {
			found = true
			break
		}
	}
	if !found {
		return errors.New("CLOUD_ADMIN_USERNAME 必须指向已有的云端数据账号")
	}
	backend, err := cloud.NewServer(ctx, cfg, db)
	if err != nil {
		return err
	}
	defer func() { stop(); backend.Wait() }()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /api/v1/catalog", application.Catalog)
	mux.HandleFunc("POST /api/v1/auth/login", backend.Login)
	mux.Handle("/api/v1/", backend)
	mux.Handle("/downloads/", application.Downloads("dist/local-runner"))
	if cfg.WebDist != "" {
		mux.Handle("/", http.FileServer(http.Dir(cfg.WebDist)))
	}
	handler := mux
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
