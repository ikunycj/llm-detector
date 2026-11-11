// Package terminalbench adapts Harbor jobs to the per-model evaluation contract.
package terminalbench

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	bench "llm-detector/internal/terminalbench"
	"llm-detector/pkg/evaluator"
)

const ID = "terminal-bench"

type Jobs interface {
	Start(context.Context, bench.Input) (bench.Job, error)
	Get(string) (bench.Job, error)
	Cancel(string) error
}

type Engine struct{ jobs Jobs }

func New(jobs Jobs) *Engine { return &Engine{jobs: jobs} }

func (*Engine) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{
		ID: ID, Name: "Terminal Bench",
		Description:            "通过 Harbor / Terminus-2 执行终端任务；支持日常 6 题和完整 89 题，需要本机 Docker 环境。",
		RequiresExplicitModels: true,
		Options: []evaluator.Option{
			{Key: "suite", Label: "测试集", Kind: "select", Default: "daily", Choices: []evaluator.Choice{{Value: "daily", Label: "日常测试集 · 6 题"}, {Value: "full", Label: "完整测试集 · 89 题"}}},
			{Key: "concurrency", Label: "题目并发数", Kind: "number", Default: 1, Min: 1, Max: 4},
		},
	}
}

func (*Engine) ProviderIndependent() bool { return true }
func (*Engine) ValidateOptions(raw json.RawMessage) error {
	_, _, err := parseOptions(raw)
	return err
}

func parseOptions(raw json.RawMessage) (string, int, error) {
	suite, concurrency := "daily", 1
	if len(raw) == 0 {
		return suite, concurrency, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return "", 0, errors.New("Terminal Bench 参数必须为 JSON 对象")
	}
	for key, value := range fields {
		switch key {
		case "suite":
			var supplied string
			if json.Unmarshal(value, &supplied) != nil || (supplied != "daily" && supplied != "full") {
				return "", 0, errors.New("Terminal Bench 测试集必须为 daily 或 full")
			}
			suite = supplied
		case "concurrency":
			var supplied int
			if json.Unmarshal(value, &supplied) != nil || supplied < 1 || supplied > 4 {
				return "", 0, errors.New("Terminal Bench 题目并发数需为 1–4")
			}
			concurrency = supplied
		default:
			return "", 0, errors.New("Terminal Bench 包含未知参数")
		}
	}
	return suite, concurrency, nil
}

func (e *Engine) Run(ctx context.Context, target evaluator.Target) (evaluator.Report, error) {
	suite, concurrency, err := parseOptions(target.Options)
	if err != nil {
		return evaluator.Report{}, err
	}
	if target.Connection.Organization != "" {
		return evaluator.Report{}, errors.New("Terminal Bench 暂不支持配置了 OpenAI Organization 的渠道")
	}
	job, err := e.jobs.Start(ctx, bench.Input{
		Suite: suite, Concurrency: concurrency, ServiceName: target.Connection.BaseURL,
		Model: target.Model.ID, BaseURL: target.Connection.BaseURL, APIKey: target.Connection.APIKey,
		Protocol: target.Connection.Protocol,
	})
	if err != nil {
		if errors.Is(err, bench.ErrBusy) || errors.Is(err, bench.ErrUnavailable) || errors.Is(err, bench.ErrInvalid) {
			return evaluator.Report{}, err
		}
		return evaluator.Report{}, errors.New("无法创建 Terminal Bench 任务，请检查服务端存储")
	}
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for job.Status == "running" || job.Status == "cancelling" {
		select {
		case <-ctx.Done():
			if err := e.jobs.Cancel(job.ID); err != nil {
				return evaluator.Report{}, errors.New("Terminal Bench 巡检中断，取消任务失败，请检查运行记录")
			}
			return evaluator.Report{}, ctx.Err()
		case <-ticker.C:
			job, err = e.jobs.Get(job.ID)
			if err != nil {
				return evaluator.Report{}, errors.New("无法读取 Terminal Bench 任务结果")
			}
		}
	}
	report := evaluator.Report{Kind: ID, Checks: make([]evaluator.Check, 0, len(job.Trials))}
	for _, trial := range job.Trials {
		check := evaluator.Check{ID: trial.Name, Name: trial.Name, Status: trial.Status, Error: trial.Error}
		if trial.Status != "passed" && trial.Status != "failed" && trial.Status != "error" {
			check.Status = "error"
			check.Error = "题目未完成验证"
		}
		if trial.Reward != nil {
			check.Output = fmt.Sprintf("verifier reward: %g", *trial.Reward)
		}
		if trial.StartedAt != nil && trial.FinishedAt != nil {
			check.LatencyMS = trial.FinishedAt.Sub(*trial.StartedAt).Milliseconds()
		}
		report.Checks = append(report.Checks, check)
	}
	// Job is the existing credential-free view, shared with the standalone page.
	report.Details, err = json.Marshal(job)
	if err != nil {
		return evaluator.Report{}, errors.New("Terminal Bench 结果编码失败")
	}
	if job.Status != "completed" && job.Status != "completed_with_errors" {
		report.Error = job.Error
		if report.Error == "" {
			report.Error = "Terminal Bench 任务未完成"
		}
	}
	return report, nil
}
