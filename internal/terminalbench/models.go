package terminalbench

import (
	"errors"
	"time"
)

var ErrNotFound = errors.New("Terminal Bench 任务不存在")
var ErrBusy = errors.New("已有 Terminal Bench 任务执行中，请等待或先取消")
var ErrInvalid = errors.New("Terminal Bench 配置无效")
var ErrUnavailable = errors.New("Terminal Bench 运行环境不可用")

type Input struct {
	Suite       string `json:"suite"`
	ServiceName string `json:"service_name"`
	BaseURL     string `json:"base_url"`
	APIKey      string `json:"api_key"`
	Protocol    string `json:"protocol"`
	Model       string `json:"model"`
	Concurrency int    `json:"concurrency"`
}

type Trial struct {
	Name       string     `json:"name"`
	Status     string     `json:"status"`
	Reward     *float64   `json:"reward"`
	Error      string     `json:"error,omitempty"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

type Job struct {
	ID            string     `json:"id"`
	Suite         string     `json:"suite"`
	Dataset       string     `json:"dataset"`
	Agent         string     `json:"agent"`
	HarborVersion string     `json:"harbor_version"`
	ServiceName   string     `json:"service_name"`
	BaseURL       string     `json:"base_url"`
	Protocol      string     `json:"protocol"`
	Model         string     `json:"model"`
	Concurrency   int        `json:"concurrency"`
	Status        string     `json:"status"`
	Error         string     `json:"error,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
	Trials        []Trial    `json:"trials"`
}

type Check struct {
	Name   string `json:"name"`
	Ready  bool   `json:"ready"`
	Detail string `json:"detail"`
}
type Readiness struct {
	Ready  bool    `json:"ready"`
	Checks []Check `json:"checks"`
}
