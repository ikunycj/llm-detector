package httpapi

import (
	"errors"
	"net/http"

	"llm-detector/internal/terminalbench"
)

func (s *Server) terminalBenchRoutes(mux *http.ServeMux, bench *terminalbench.Service) {
	mux.Handle("GET /api/v1/terminal-bench/catalog", s.protect(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, bench.Catalog()) }))
	mux.Handle("GET /api/v1/terminal-bench/readiness", s.protect(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, bench.Check(r.Context())) }))
	mux.Handle("GET /api/v1/terminal-bench/jobs", s.protect(func(w http.ResponseWriter, r *http.Request) {
		items, err := bench.List()
		if err != nil {
			benchError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"jobs": items})
	}))
	mux.Handle("POST /api/v1/terminal-bench/jobs", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input terminalbench.Input
		if !decode(w, r, &input) {
			return
		}
		job, err := bench.Start(r.Context(), input)
		if err != nil {
			benchError(w, err)
			return
		}
		writeJSON(w, 202, job)
	}))
	mux.Handle("GET /api/v1/terminal-bench/jobs/{id}", s.protect(func(w http.ResponseWriter, r *http.Request) {
		job, err := bench.Get(r.PathValue("id"))
		if err != nil {
			benchError(w, err)
			return
		}
		writeJSON(w, 200, job)
	}))
	mux.Handle("POST /api/v1/terminal-bench/jobs/{id}/cancel", s.protect(func(w http.ResponseWriter, r *http.Request) {
		if err := bench.Cancel(r.PathValue("id")); err != nil {
			benchError(w, err)
			return
		}
		w.WriteHeader(204)
	}))
}
func benchError(w http.ResponseWriter, err error) {
	status, message := 500, "Terminal Bench 操作失败，请检查服务端存储和运行状态"
	switch {
	case errors.Is(err, terminalbench.ErrInvalid):
		status, message = 400, err.Error()
	case errors.Is(err, terminalbench.ErrNotFound):
		status, message = 404, err.Error()
	case errors.Is(err, terminalbench.ErrBusy):
		status, message = 409, err.Error()
	case errors.Is(err, terminalbench.ErrUnavailable):
		status, message = 503, err.Error()
	}
	writeError(w, status, message)
}
