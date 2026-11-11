package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"llm-detector/internal/auth"
	"llm-detector/internal/evaluators"
	"llm-detector/internal/inspection"
	"llm-detector/internal/providers"
	"llm-detector/internal/scan"
	"llm-detector/internal/terminalbench"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/provider"
)

type Server struct {
	auth      *auth.Service
	providers *providers.Registry
	engines   *evaluators.Registry
	scans     *scan.Service
}

func NewServer(a *auth.Service, p *providers.Registry, e *evaluators.Registry, s *scan.Service, webDist string, jobs *inspection.Service, bench *terminalbench.Service) http.Handler {
	api := &Server{auth: a, providers: p, engines: e, scans: s}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	if a != nil {
		mux.HandleFunc("POST /api/v1/auth/login", api.login)
		mux.Handle("POST /api/v1/auth/logout", api.protect(func(w http.ResponseWriter, r *http.Request) {
			a.Logout(r.Header.Get("Authorization"))
			w.WriteHeader(204)
		}))
	}
	mux.Handle("GET /api/v1/providers", api.protect(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"providers": p.List()}) }))
	mux.Handle("GET /api/v1/evaluators", api.protect(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"evaluators": e.List()})
	}))
	mux.Handle("POST /api/v1/models/discover", api.protect(api.discover))
	mux.Handle("POST /api/v1/scans", api.protect(api.createScan))
	mux.Handle("GET /api/v1/scans", api.protect(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.List()
		if err != nil {
			writeError(w, 500, "无法读取扫描结果")
			return
		}
		writeJSON(w, 200, map[string]any{"scans": items})
	}))
	mux.Handle("GET /api/v1/scans/{id}", api.protect(api.getScan))
	if jobs != nil {
		api.inspectionRoutes(mux, jobs)
	}
	if bench != nil {
		api.terminalBenchRoutes(mux, bench)
	}
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { writeError(w, 404, "endpoint not found") })
	if webDist != "" {
		mux.Handle("/", http.FileServer(http.Dir(webDist)))
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		mux.ServeHTTP(w, r)
	})
}
func (s *Server) protect(next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.auth != nil && !s.auth.Authenticate(r.Header.Get("Authorization")) {
			writeError(w, 401, "authentication required")
			return
		}
		next(w, r)
	})
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Key string `json:"key"`
	}
	if !decode(w, r, &input) {
		return
	}
	token, expires, err := s.auth.Login(input.Key)
	if errors.Is(err, auth.ErrInvalidKey) {
		writeError(w, 401, "invalid login key")
		return
	}
	if err != nil {
		writeError(w, 500, "could not create session")
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "expires_at": expires})
}

type connectionInput struct {
	Vendor      string `json:"vendor"`
	ServiceName string `json:"service_name"`
	Protocol    string `json:"protocol"`
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
}

func (s *Server) connection(input connectionInput) (provider.Connection, error) {
	if _, ok := s.providers.Get(input.Vendor); !ok {
		return provider.Connection{}, errors.New("unknown provider")
	}
	return parseConnection(input.BaseURL, input.APIKey, input.Protocol)
}

func parseConnection(baseURL, apiKey, protocol string) (provider.Connection, error) {
	if protocol == "" {
		protocol = "chat_completions"
	}
	if protocol != "chat_completions" && protocol != "responses" && protocol != "messages" {
		return provider.Connection{}, errors.New("protocol must be chat_completions, responses or messages")
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || base.Hostname() == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return provider.Connection{}, errors.New("base_url must be an HTTP(S) API root without credentials, query or fragment")
	}
	if strings.TrimSpace(apiKey) == "" || strings.ContainsAny(apiKey, "\r\n") {
		return provider.Connection{}, errors.New("api_key is required and must not contain line breaks")
	}
	return provider.Connection{BaseURL: strings.TrimRight(base.String(), "/"), APIKey: apiKey, Protocol: protocol}, nil
}
func (s *Server) discover(w http.ResponseWriter, r *http.Request) {
	var input connectionInput
	if !decode(w, r, &input) {
		return
	}
	conn, err := s.connection(input)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	adapter, _ := s.providers.Get(input.Vendor)
	models, err := adapter.DiscoverModels(r.Context(), conn)
	if err != nil {
		writeError(w, 502, strings.ReplaceAll(err.Error(), conn.APIKey, "[REDACTED]"))
		return
	}
	writeJSON(w, 200, map[string]any{"models": models})
}
func (s *Server) createScan(w http.ResponseWriter, r *http.Request) {
	var input struct {
		connectionInput
		Scope            string          `json:"scope"`
		Models           []string        `json:"models"`
		Evaluator        string          `json:"evaluator"`
		EvaluatorOptions json.RawMessage `json:"evaluator_options"`
	}
	if !decode(w, r, &input) {
		return
	}
	engine, ok := s.engines.Get(input.Evaluator)
	if !ok {
		writeError(w, 400, "unknown evaluator")
		return
	}
	independent, isIndependent := engine.(evaluator.ProviderIndependent)
	isProviderIndependent := isIndependent && independent.ProviderIndependent()
	var conn provider.Connection
	var err error
	if isProviderIndependent {
		if input.Vendor != "" {
			if _, ok := s.providers.Get(input.Vendor); !ok {
				writeError(w, 400, "unknown provider")
				return
			}
		}
		conn, err = parseConnection(input.BaseURL, input.APIKey, input.Protocol)
	} else {
		conn, err = s.connection(input.connectionInput)
	}
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	options := input.EvaluatorOptions
	if len(options) == 0 {
		options = json.RawMessage(`{}`)
	}
	var optionObject map[string]json.RawMessage
	if err := json.Unmarshal(options, &optionObject); err != nil || optionObject == nil {
		writeError(w, 400, "evaluator_options must be a JSON object")
		return
	}
	if validator, ok := engine.(evaluator.OptionsValidator); ok {
		if err := validator.ValidateOptions(options); err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	if input.Scope != "all" && input.Scope != "selected" {
		writeError(w, 400, "scope must be all or selected")
		return
	}
	if engine.Descriptor().RequiresExplicitModels && input.Scope == "all" {
		writeError(w, 400, "this evaluator requires one or more explicitly selected model IDs")
		return
	}
	if input.Scope == "all" && len(input.Models) > 0 {
		writeError(w, 400, "models must be empty when scope is all")
		return
	}
	seen := make(map[string]bool)
	models := []string{}
	for _, id := range input.Models {
		id = strings.TrimSpace(id)
		if id == "" {
			writeError(w, 400, "model IDs must not be empty")
			return
		}
		if !seen[id] {
			models = append(models, id)
			seen[id] = true
		}
	}
	if input.Scope == "selected" && len(models) == 0 {
		writeError(w, 400, "select at least one model")
		return
	}
	if !isProviderIndependent && input.Vendor == "" {
		writeError(w, 400, "vendor is required")
		return
	}
	item, err := s.scans.Start(scan.Request{Vendor: input.Vendor, ServiceName: input.ServiceName, Connection: conn, Scope: input.Scope, Models: models, Evaluator: input.Evaluator, Options: options})
	if err != nil {
		writeError(w, 500, "could not create scan")
		return
	}
	writeJSON(w, 202, item)
}
func (s *Server) getScan(w http.ResponseWriter, r *http.Request) {
	item, err := s.scans.Get(r.PathValue("id"))
	if errors.Is(err, scan.ErrNotFound) {
		writeError(w, 404, err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "could not read scan")
		return
	}
	writeJSON(w, 200, item)
}
func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, 400, "invalid JSON body or unknown fields")
		return false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		writeError(w, 400, "body must contain one JSON value")
		return false
	}
	return true
}
func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
