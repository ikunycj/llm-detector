package localruntime

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"llm-detector/internal/application"
	"llm-detector/internal/config"
	"llm-detector/internal/inspection"
	"llm-detector/internal/store"
	"llm-detector/internal/terminalbench"
)

type MemoryState struct {
	mu   sync.Mutex
	data []byte
}

func (m *MemoryState) Save(state inspection.State) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.data = data
	m.mu.Unlock()
	return nil
}
func (m *MemoryState) Snapshot() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]byte(nil), m.data...)
}

type session struct {
	origin  string
	runtime *application.Runtime
	state   *MemoryState
	cancel  context.CancelFunc
}
type Server struct {
	mu             sync.Mutex
	ctx            context.Context
	cfg            config.Config
	Root           string
	allowedOrigins map[string]bool
	sessions       map[string]*session
	installer      *Installer
}

func New(ctx context.Context, depRoot string, allowedOrigins ...string) (*Server, error) {
	root, err := os.MkdirTemp("", "llm-detector-local-")
	if err != nil {
		return nil, err
	}
	cfg := config.Config{RequestTimeout: 30 * time.Second, FingerprintRequestTimeout: 120 * time.Second, TerminalBenchBinary: HarborBinary(depRoot), FingerprintCachePath: filepath.Join(depRoot, "fingerprint-cache")}
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{"http://127.0.0.1:9000", "http://localhost:9000"}
	}
	origins := map[string]bool{}
	for _, origin := range allowedOrigins {
		if origin = strings.TrimRight(strings.TrimSpace(origin), "/"); origin != "" {
			origins[origin] = true
		}
	}
	return &Server{ctx: ctx, cfg: cfg, Root: root, allowedOrigins: origins, sessions: map[string]*session{}, installer: &Installer{Root: depRoot}}, nil
}
func RandomToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
func (s *Server) Close() error {
	s.mu.Lock()
	items := []*session{}
	for _, item := range s.sessions {
		item.cancel()
		items = append(items, item)
	}
	s.mu.Unlock()
	for _, item := range items {
		item.runtime.Wait()
	}
	s.installer.Wait()
	return os.RemoveAll(s.Root)
}
func reply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func reject(w http.ResponseWriter, status int, message string) {
	reply(w, status, map[string]string{"error": message})
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil || (host != "127.0.0.1" && host != "localhost") {
		reject(w, 403, "本机执行器仅接受回环地址")
		return
	}
	origin := r.Header.Get("Origin")
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		reject(w, 403, "无效的页面来源")
		return
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Private-Network", "true")
	if r.Method == "OPTIONS" {
		w.WriteHeader(204)
		return
	}
	if r.URL.Path == "/healthz" && r.Method == "GET" {
		reply(w, 200, map[string]string{"status": "ok", "mode": "local"})
		return
	}
	if r.URL.Path == "/api/v1/local/connect" && r.Method == "POST" {
		if !s.allowedOrigins[origin] {
			reject(w, 403, "本机执行器未允许此页面来源，请使用 --origin 配置")
			return
		}
		var input struct {
			State json.RawMessage `json:"state"`
		}
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20))
		d.DisallowUnknownFields()
		if d.Decode(&input) != nil || d.Decode(&struct{}{}) != io.EOF {
			reject(w, 400, "本地连接参数无效")
			return
		}
		state := inspection.EmptyState()
		if len(input.State) > 0 && string(input.State) != "null" {
			if json.Unmarshal(input.State, &state) != nil || state.Version != 1 || state.Projects == nil {
				reject(w, 400, "浏览器项目数据无效")
				return
			}
		}
		for id, item := range state.Projects {
			if id == "" || item.View.ID != id || item.View.Kind != "newapi" {
				reject(w, 400, "浏览器项目数据不受支持")
				return
			}
		}
		token, err := RandomToken()
		if err != nil {
			reject(w, 500, "无法建立本地会话")
			return
		}
		ctx, cancel := context.WithCancel(s.ctx)
		memory := &MemoryState{}
		runtime, err := application.New(ctx, s.cfg, filepath.Join(s.Root, token), store.NewMemory(), memory, state, terminalbench.TransientStore{}, true)
		if err != nil {
			cancel()
			reject(w, 500, "本机执行环境初始化失败")
			return
		}
		s.mu.Lock()
		s.sessions[token] = &session{origin: origin, runtime: runtime, state: memory, cancel: cancel}
		s.mu.Unlock()
		reply(w, 200, map[string]string{"token": token})
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	s.mu.Lock()
	item := s.sessions[token]
	s.mu.Unlock()
	if !ok || item == nil || item.origin != origin {
		reject(w, 401, "请连接本机执行器")
		return
	}
	switch r.URL.Path {
	case "/api/v1/local/state":
		if r.Method != "GET" {
			reject(w, 405, "method not allowed")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(item.state.Snapshot())
		return
	case "/api/v1/local/session":
		if r.Method != "DELETE" {
			reject(w, 405, "method not allowed")
			return
		}
		s.mu.Lock()
		delete(s.sessions, token)
		s.mu.Unlock()
		item.cancel()
		item.runtime.Wait()
		if err := os.RemoveAll(filepath.Join(s.Root, token)); err != nil {
			reject(w, 500, "本地任务清理失败")
			return
		}
		w.WriteHeader(204)
		return
	case "/api/v1/local/dependencies":
		if r.Method == "POST" {
			s.installer.Start(s.ctx)
		} else if r.Method == "DELETE" {
			if err := s.removeDependencies(); err != nil {
				reject(w, 409, err.Error())
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		} else if r.Method != "GET" {
			reject(w, 405, "method not allowed")
			return
		}
		reply(w, 200, s.installer.State())
		return
	}
	if strings.HasSuffix(r.URL.Path, "/plan") && r.Method == "PUT" {
		var plan inspection.Plan
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		d.DisallowUnknownFields()
		if d.Decode(&plan) != nil || d.Decode(&struct{}{}) != io.EOF {
			reject(w, 400, "计划无效")
			return
		}
		if plan.Enabled {
			reject(w, 400, "本地模式不支持服务端定时巡检，请手动触发")
			return
		}
		b, _ := json.Marshal(plan)
		r = r.Clone(r.Context())
		r.Body = io.NopCloser(strings.NewReader(string(b)))
		r.ContentLength = int64(len(b))
	}
	item.runtime.Handler.ServeHTTP(w, r)
}

func (s *Server) removeDependencies() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, item := range s.sessions {
		if item.runtime.Bench != nil && item.runtime.Bench.Busy() {
			return errors.New("Terminal Bench 正在运行，请先等待或取消任务")
		}
	}
	return s.installer.Remove()
}
