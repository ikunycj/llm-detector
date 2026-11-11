package inspection

import (
	"encoding/json"
	"errors"
	"time"

	"llm-detector/internal/scan"
	"llm-detector/pkg/project"
)

var (
	ErrNotFound = errors.New("项目不存在")
	ErrBusy     = errors.New("项目正在同步或巡检，请等待当前操作结束")
)

type Input struct {
	AdminAccount string `json:"admin_account"`
	Password     string `json:"password"`
	LoginCode    string `json:"login_code"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	BaseURL      string `json:"base_url"`
	UserID       int    `json:"user_id"`
	AccessToken  string `json:"access_token"`
}

type Plan struct {
	Mode             string                     `json:"mode"` // all, groups, channels
	Groups           []string                   `json:"groups"`
	ChannelIDs       []string                   `json:"channel_ids"`
	Models           []string                   `json:"models"` // upstream IDs, empty uses channel models
	Evaluators       []string                   `json:"evaluators"`
	EvaluatorOptions map[string]json.RawMessage `json:"evaluator_options,omitempty"`
	Enabled          bool                       `json:"enabled"`
	IntervalMinutes  int                        `json:"interval_minutes"`
}

type ChannelView struct {
	project.Channel
	ProtocolOverride string `json:"protocol_override,omitempty"`
	HasKey           bool   `json:"has_key"`
	KeyError         string `json:"key_error,omitempty"`
}

type Project struct {
	AdminAccount string        `json:"admin_account,omitempty"`
	ID           string        `json:"id"`
	Name         string        `json:"name"`
	Kind         string        `json:"kind"`
	BaseURL      string        `json:"base_url"`
	UserID       int           `json:"user_id"`
	HasToken     bool          `json:"has_token"`
	Channels     []ChannelView `json:"channels"`
	Groups       []string      `json:"groups"`
	Plan         Plan          `json:"plan"`
	SyncedAt     *time.Time    `json:"synced_at,omitempty"`
	NextRunAt    *time.Time    `json:"next_run_at,omitempty"`
	Busy         bool          `json:"busy"`
	LastError    string        `json:"last_error,omitempty"`
}

type Run struct {
	ID          string     `json:"id"`
	ProjectID   string     `json:"project_id"`
	ProjectName string     `json:"project_name"`
	Trigger     string     `json:"trigger"` // manual, schedule
	Status      string     `json:"status"`
	Items       []RunItem  `json:"items"`
	Error       string     `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

type RunItem struct {
	ChannelID   string     `json:"channel_id"`
	ChannelName string     `json:"channel_name"`
	Groups      []string   `json:"groups"`
	Evaluator   string     `json:"evaluator"`
	Protocol    string     `json:"protocol,omitempty"`
	Models      []string   `json:"models"`
	Status      string     `json:"status"`
	Error       string     `json:"error,omitempty"`
	ScanID      string     `json:"scan_id,omitempty"`
	Result      *scan.Scan `json:"result,omitempty"`
}

// diskProject is only serialized inside the authenticated encrypted store.
// HTTP handlers return Project views, never this credential-bearing record.
type diskProject struct {
	View        Project           `json:"view"`
	AccessToken string            `json:"access_token"`
	Keys        map[string]string `json:"keys"`
}
type state struct {
	Version  int                    `json:"version"`
	Projects map[string]diskProject `json:"projects"`
	Runs     []Run                  `json:"runs"`
}
