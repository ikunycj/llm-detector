package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"llm-detector/internal/application"
	"llm-detector/internal/config"
)

type Server struct {
	db       *Database
	cfg      config.Config
	ctx      context.Context
	mu       sync.Mutex
	runtimes map[int64]*application.Runtime
	attempts map[string][]time.Time
}

func NewServer(ctx context.Context, cfg config.Config, db *Database) (*Server, error) {
	s := &Server{db: db, cfg: cfg, ctx: ctx, runtimes: map[int64]*application.Runtime{}, attempts: map[string][]time.Time{}}
	users, err := db.Users()
	if err != nil {
		return nil, err
	}
	for _, user := range users {
		if _, err = s.runtime(user.ID); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *Server) runtime(userID int64) (*application.Runtime, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if runtime := s.runtimes[userID]; runtime != nil {
		return runtime, nil
	}
	scans := ScanStore{s.db, userID}
	if err := scans.CleanupLegacy(); err != nil {
		return nil, err
	}
	if err := scans.Recover(); err != nil {
		return nil, err
	}
	projects := InspectionStore{s.db, userID}
	state, err := projects.Load()
	if err != nil {
		return nil, err
	}
	runtime, err := application.New(s.ctx, s.cfg, filepath.Join(s.cfg.DataDir, "cloud-artifacts", strconv.FormatInt(userID, 10)), scans, projects, state, BenchStore{s.db, userID}, false)
	if err == nil {
		s.runtimes[userID] = runtime
	}
	return runtime, err
}
func (s *Server) Wait() {
	s.mu.Lock()
	items := []*application.Runtime{}
	for _, runtime := range s.runtimes {
		items = append(items, runtime)
	}
	s.mu.Unlock()
	for _, runtime := range items {
		runtime.Wait()
	}
}
func respond(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func failure(w http.ResponseWriter, status int, message string) {
	respond(w, status, map[string]string{"error": message})
}
func decode(w http.ResponseWriter, r *http.Request, value any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20))
	d.DisallowUnknownFields()
	if d.Decode(value) != nil || d.Decode(&struct{}{}) != io.EOF {
		failure(w, 400, "请求格式无效")
		return false
	}
	return true
}
func (s *Server) Login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &input) {
		return
	}
	if len(input.Username) > 128 || len(input.Password) > 256 {
		failure(w, 400, "账号或密码格式无效")
		return
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	now := time.Now()
	s.mu.Lock()
	attempts := s.attempts[host][:0]
	for _, at := range s.attempts[host] {
		if now.Sub(at) < time.Minute {
			attempts = append(attempts, at)
		}
	}
	if len(attempts) >= 10 {
		s.mu.Unlock()
		failure(w, 429, "登录尝试过于频繁，请稍后再试")
		return
	}
	s.attempts[host] = append(attempts, now)
	s.mu.Unlock()
	user, token, expiry, err := s.db.Login(input.Username, input.Password, s.cfg.SessionTTL)
	if errors.Is(err, ErrCredentials) {
		failure(w, 401, ErrCredentials.Error())
		return
	}
	if err != nil {
		failure(w, 500, "登录服务不可用")
		return
	}
	respond(w, 200, map[string]any{"user": user, "token": token, "expires_at": expiry})
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	user, err := s.db.Authenticate(r.Header.Get("Authorization"))
	if err != nil {
		if errors.Is(err, ErrCredentials) {
			failure(w, 401, "请登录云端账号")
		} else {
			failure(w, 500, "账号服务不可用")
		}
		return
	}
	switch r.URL.Path {
	case "/api/v1/auth/me":
		if r.Method != "GET" {
			failure(w, 405, "method not allowed")
			return
		}
		respond(w, 200, user)
		return
	case "/api/v1/auth/logout":
		if r.Method != "POST" {
			failure(w, 405, "method not allowed")
			return
		}
		if err := s.db.Logout(r.Header.Get("Authorization")); err != nil {
			failure(w, 500, "退出失败")
			return
		}
		w.WriteHeader(204)
		return
	case "/api/v1/model-services":
		s.modelServices(w, r, user.ID)
		return
	}
	runtime, err := s.runtime(user.ID)
	if err != nil {
		failure(w, 500, "云端工作区无法加载")
		return
	}
	// Resolve saved credentials only inside the authenticated owner's workspace.
	if r.Method == "POST" && (r.URL.Path == "/api/v1/scans" || r.URL.Path == "/api/v1/models/discover" || r.URL.Path == "/api/v1/terminal-bench/jobs") {
		var fields map[string]json.RawMessage
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		if d.Decode(&fields) != nil || fields == nil || d.Decode(&struct{}{}) != io.EOF {
			failure(w, 400, "请求格式无效")
			return
		}
		if value, ok := fields["service_id"]; ok {
			var id string
			if json.Unmarshal(value, &id) != nil {
				failure(w, 400, "配置 ID 无效")
				return
			}
			services, err := s.loadServices(user.ID)
			if err != nil {
				failure(w, 500, "无法读取模型配置")
				return
			}
			var selected *ModelAPI
			for i := range services {
				if services[i].ID == id {
					selected = &services[i]
					break
				}
			}
			if selected == nil {
				failure(w, 404, "模型 API 配置不存在")
				return
			}
			values := map[string]string{"base_url": selected.BaseURL, "api_key": selected.APIKey, "protocol": selected.Protocol, "service_name": selected.Name}
			if r.URL.Path != "/api/v1/terminal-bench/jobs" {
				values["vendor"] = selected.Vendor
			}
			for key, value := range values {
				fields[key], _ = json.Marshal(value)
			}
			delete(fields, "service_id")
		}
		body, err := json.Marshal(fields)
		if err != nil {
			failure(w, 400, "请求格式无效")
			return
		}
		r = r.Clone(r.Context())
		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
	}
	runtime.Handler.ServeHTTP(w, r)
}
