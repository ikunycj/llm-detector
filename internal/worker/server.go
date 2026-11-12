// Package worker exposes the cloud runtime behind a single owner-controlled key.
package worker

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"llm-detector/internal/application"
	"llm-detector/internal/cloud"
	"llm-detector/internal/config"
	"llm-detector/internal/localruntime"
)

type Server struct {
	app       *cloud.Server
	account   cloud.User
	key       [32]byte
	origins   map[string]bool
	installer *localruntime.Installer
	ctx       context.Context
}

func New(ctx context.Context, cfg config.Config, db *cloud.Database, key string, origins []string, deps string) (*Server, error) {
	if strings.TrimSpace(key) == "" {
		return nil, errors.New("WORKER_KEY is required")
	}
	users, err := db.Users()
	if err != nil {
		return nil, err
	}
	var account cloud.User
	if len(users) == 0 {
		account, err = db.CreateUser("worker", key)
		if err != nil {
			return nil, err
		}
	} else if len(users) == 1 && users[0].Username == "worker" {
		account = users[0]
	} else {
		return nil, errors.New("Worker 必须使用独立的数据目录，不能使用云端账号数据库")
	}
	app, err := cloud.NewServer(ctx, cfg, db)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, origin := range origins {
		allowed[strings.TrimRight(strings.TrimSpace(origin), "/")] = true
	}
	return &Server{app: app, account: account, key: sha256.Sum256([]byte(key)), origins: allowed, installer: &localruntime.Installer{Root: deps}, ctx: ctx}, nil
}
func (s *Server) Wait() { s.app.Wait(); s.installer.Wait() }
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	origin := r.Header.Get("Origin")
	if origin != "" {
		if !s.origins[origin] {
			http.Error(w, "Worker 未允许此页面来源，请配置 WORKER_ORIGINS", 403)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(204)
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	digest := sha256.Sum256([]byte(token))
	if !ok || subtle.ConstantTimeCompare(digest[:], s.key[:]) != 1 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(401)
		json.NewEncoder(w).Encode(map[string]string{"error": "Worker 密钥无效"})
		return
	}
	switch r.URL.Path {
	case "/api/v1/worker/info":
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"name": "LLM Detector Worker", "protocol_version": 1, "storage": "sqlite", "engines": []string{"fingerprint", "terminal-bench"}})
	case "/api/v1/catalog":
		application.Catalog(w, r)
	case "/api/v1/local/dependencies":
		if r.Method == "POST" {
			s.installer.Start(s.ctx)
		} else if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(s.installer.State())
	default:
		if strings.HasPrefix(r.URL.Path, "/api/v1/auth/") {
			http.NotFound(w, r)
			return
		}
		s.app.ServeUser(w, r, s.account)
	}
}
