package cloud

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
)

type ModelAPI struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Vendor      string   `json:"vendor"`
	ServiceName string   `json:"service_name"`
	Protocol    string   `json:"protocol"`
	BaseURL     string   `json:"base_url"`
	APIKey      string   `json:"api_key"`
	HasKey      bool     `json:"has_key,omitempty"`
	Scope       string   `json:"scope"`
	Models      []string `json:"models"`
	UpdatedAt   string   `json:"updated_at"`
}

func (s *Server) loadServices(userID int64) ([]ModelAPI, error) {
	b, err := s.db.Get(userID, "model-apis", "all")
	if errors.Is(err, sql.ErrNoRows) {
		return []ModelAPI{}, nil
	}
	if err != nil {
		return nil, err
	}
	var items []ModelAPI
	err = json.Unmarshal(b, &items)
	return items, err
}
func (s *Server) modelServices(w http.ResponseWriter, r *http.Request, userID int64) {
	items, err := s.loadServices(userID)
	if err != nil {
		failure(w, 500, "无法读取模型 API")
		return
	}
	if r.Method == "PUT" {
		var updated []ModelAPI
		if !decode(w, r, &updated) {
			return
		}
		if updated == nil || len(updated) > 1000 {
			failure(w, 400, "配置需为最多 1000 项的数组")
			return
		}
		old := map[string]ModelAPI{}
		for _, item := range items {
			old[item.ID] = item
		}
		seen := map[string]bool{}
		for i := range updated {
			item := &updated[i]
			if item.APIKey == "" {
				item.APIKey = old[item.ID].APIKey
			}
			item.Name = strings.TrimSpace(item.Name)
			item.ServiceName = item.Name
			item.HasKey = false
			base, err := url.Parse(item.BaseURL)
			if item.ID == "" || seen[item.ID] || len(item.ID) > 128 || item.Name == "" || item.Vendor != "openai-compatible" || err != nil || base.Hostname() == "" || (base.Scheme != "https" && base.Scheme != "http") || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" || strings.TrimSpace(item.APIKey) == "" || strings.ContainsAny(item.APIKey, "\r\n") {
				failure(w, 400, "模型 API 名称、地址或密钥无效")
				return
			}
			if item.Protocol != "chat_completions" && item.Protocol != "responses" && item.Protocol != "messages" {
				failure(w, 400, "请求协议无效")
				return
			}
			if item.Scope != "all" && item.Scope != "selected" {
				failure(w, 400, "巡检范围无效")
				return
			}
			if item.Scope == "selected" && len(item.Models) == 0 {
				failure(w, 400, "请指定至少一个模型")
				return
			}
			for _, model := range item.Models {
				if strings.TrimSpace(model) == "" {
					failure(w, 400, "模型 ID 不能为空")
					return
				}
			}
			seen[item.ID] = true
		}
		b, err := json.Marshal(updated)
		if err != nil {
			failure(w, 400, "配置编码失败")
			return
		}
		if err = s.db.Put(userID, "model-apis", "all", b); err != nil {
			failure(w, 500, "模型 API 保存失败")
			return
		}
		items = updated
	} else if r.Method != "GET" {
		failure(w, 405, "method not allowed")
		return
	}
	for i := range items {
		items[i].HasKey = items[i].APIKey != ""
		items[i].APIKey = ""
	}
	respond(w, 200, map[string]any{"services": items})
}

// Explicit transfer only: list responses continue to redact credentials.
func (s *Server) transferService(w http.ResponseWriter, r *http.Request, userID int64) {
	if r.Method != http.MethodPost {
		failure(w, 405, "method not allowed")
		return
	}
	var input struct {
		ID string `json:"id"`
	}
	if !decode(w, r, &input) {
		return
	}
	services, err := s.loadServices(userID)
	if err != nil {
		failure(w, 500, "无法读取模型配置")
		return
	}
	for _, service := range services {
		if service.ID == input.ID {
			respond(w, 200, service)
			return
		}
	}
	failure(w, 404, "模型 API 配置不存在")
}
