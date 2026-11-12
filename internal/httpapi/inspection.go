package httpapi

import (
	"errors"
	"net/http"
	"time"

	"llm-detector/internal/inspection"
)

func (s *Server) inspectionRoutes(mux *http.ServeMux, jobs *inspection.Service) {
	mux.Handle("POST /api/v1/inspection/projects/{id}/transfer", s.protect(func(w http.ResponseWriter, r *http.Request) {
		item, err := jobs.Export(r.PathValue("id"))
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("POST /api/v1/inspection/projects/import", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input inspection.Transfer
		if !decode(w, r, &input) {
			return
		}
		item, err := jobs.Import(input)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 201, item)
	}))
	mux.Handle("GET /api/v1/inspection/projects", s.protect(func(w http.ResponseWriter, r *http.Request) {
		items, err := jobs.List()
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"projects": items})
	}))
	mux.Handle("POST /api/v1/inspection/projects", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input inspection.Input
		if !decode(w, r, &input) {
			return
		}
		if !inspectionDeadline(w) {
			return
		}
		item, err := jobs.SaveConnection(r.Context(), "", input)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 201, item)
	}))
	mux.Handle("PUT /api/v1/inspection/projects/{id}", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input inspection.Input
		if !decode(w, r, &input) {
			return
		}
		if !inspectionDeadline(w) {
			return
		}
		item, err := jobs.SaveConnection(r.Context(), r.PathValue("id"), input)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("DELETE /api/v1/inspection/projects/{id}", s.protect(func(w http.ResponseWriter, r *http.Request) {
		if err := jobs.Delete(r.PathValue("id")); err != nil {
			inspectionError(w, err)
			return
		}
		w.WriteHeader(204)
	}))
	mux.Handle("POST /api/v1/inspection/projects/{id}/sync", s.protect(func(w http.ResponseWriter, r *http.Request) {
		if !inspectionDeadline(w) {
			return
		}
		var input struct {
			ImportKeys bool   `json:"import_keys"`
			Code       string `json:"two_factor_code"`
		}
		if r.ContentLength != 0 && !decode(w, r, &input) {
			return
		}
		var item inspection.Project
		var err error
		if input.ImportKeys {
			item, err = jobs.SyncAndImport(r.Context(), r.PathValue("id"), input.Code)
		} else {
			item, err = jobs.Sync(r.Context(), r.PathValue("id"))
		}
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("POST /api/v1/inspection/projects/{id}/keys", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			IDs  []string `json:"channel_ids"`
			Code string   `json:"two_factor_code"`
		}
		if !decode(w, r, &input) {
			return
		}
		if !inspectionDeadline(w) {
			return
		}
		item, err := jobs.ImportKeys(r.Context(), r.PathValue("id"), input.IDs, input.Code)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("PUT /api/v1/inspection/projects/{id}/plan", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input inspection.Plan
		if !decode(w, r, &input) {
			return
		}
		item, err := jobs.UpdatePlan(r.PathValue("id"), input)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("PUT /api/v1/inspection/projects/{id}/channels/{channelID}/protocol", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Protocol *string `json:"protocol"`
		}
		if !decode(w, r, &input) {
			return
		}
		if input.Protocol == nil {
			writeError(w, 400, "请指定测试协议，或传空字符串跟随渠道")
			return
		}
		item, err := jobs.UpdateChannelProtocol(r.PathValue("id"), r.PathValue("channelID"), *input.Protocol)
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, item)
	}))
	mux.Handle("POST /api/v1/inspection/projects/{id}/run", s.protect(func(w http.ResponseWriter, r *http.Request) {
		run, err := jobs.Run(r.PathValue("id"), "manual")
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 202, run)
	}))
	mux.Handle("POST /api/v1/inspection/batch-run", s.protect(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			IDs []string `json:"project_ids"`
		}
		if !decode(w, r, &input) {
			return
		}
		if len(input.IDs) == 0 {
			writeError(w, 400, "请选择项目")
			return
		}
		type outcome struct {
			ProjectID string `json:"project_id"`
			RunID     string `json:"run_id,omitempty"`
			Error     string `json:"error,omitempty"`
		}
		out := []outcome{}
		seen := map[string]bool{}
		for _, id := range input.IDs {
			if seen[id] {
				continue
			}
			seen[id] = true
			run, err := jobs.Run(id, "manual")
			row := outcome{ProjectID: id, RunID: run.ID}
			if err != nil {
				row.Error = inspectionMessage(err)
			}
			out = append(out, row)
		}
		writeJSON(w, 200, map[string]any{"outcomes": out})
	}))
	mux.Handle("GET /api/v1/inspection/runs", s.protect(func(w http.ResponseWriter, r *http.Request) {
		runs, err := jobs.Runs(r.URL.Query().Get("project_id"))
		if err != nil {
			inspectionError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"runs": runs})
	}))
}
func inspectionMessage(err error) string {
	if errors.Is(err, inspection.ErrNotFound) || errors.Is(err, inspection.ErrBusy) || errors.Is(err, inspection.ErrInvalid) || errors.Is(err, inspection.ErrUpstream) {
		return err.Error()
	}
	return "巡检服务无法完成操作，请检查服务端存储和运行状态"
}
func inspectionError(w http.ResponseWriter, err error) {
	status := 500
	switch {
	case errors.Is(err, inspection.ErrNotFound):
		status = 404
	case errors.Is(err, inspection.ErrBusy):
		status = 409
	case errors.Is(err, inspection.ErrInvalid):
		status = 400
	case errors.Is(err, inspection.ErrUpstream):
		status = 502
	}
	writeError(w, status, inspectionMessage(err))
}

func inspectionDeadline(w http.ResponseWriter) bool {
	err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(4*time.Minute + 5*time.Second))
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		writeError(w, 500, "无法设置项目同步响应超时")
		return false
	}
	return true
}
