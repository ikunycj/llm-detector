package terminalbench

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

type Service struct {
	mu        sync.Mutex
	ctx       context.Context
	root      string
	catalog   Catalog
	runner    Runner
	jobs      map[string]Job
	active    string
	cancel    context.CancelFunc
	preparing bool
	workers   sync.WaitGroup
	fault     error
	store     Store
	cleanup   bool
}

func NewService(ctx context.Context, root string, runner Runner) (*Service, error) {
	return NewServiceWithStore(ctx, root, runner, fileStore{root: root}, false)
}
func NewServiceWithStore(ctx context.Context, root string, runner Runner, storage Store, cleanup bool) (*Service, error) {
	catalog, err := LoadCatalog()
	if err != nil {
		return nil, err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	s := &Service{ctx: ctx, root: root, catalog: catalog, runner: runner, jobs: map[string]Job{}, store: storage, cleanup: cleanup}
	items, err := storage.Load()
	if err != nil {
		return nil, err
	}
	for _, job := range items {
		if job.Status == "running" || job.Status == "cancelling" {
			job.Status = "interrupted"
			job.Error = "服务重启中断了运行；不会自动恢复或重复调用模型"
			now := time.Now().UTC()
			job.FinishedAt = &now
			for i := range job.Trials {
				if job.Trials[i].Status == "pending" || job.Trials[i].Status == "running" {
					job.Trials[i].Status = "interrupted"
				}
			}
			if err = s.store.Save(job); err != nil {
				return nil, err
			}
		}
		s.jobs[job.ID] = job
	}
	return s, nil
}
func (s *Service) Catalog() Catalog                    { return s.catalog }
func (s *Service) Check(ctx context.Context) Readiness { return s.runner.Check(ctx) }
func (s *Service) List() ([]Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return nil, s.fault
	}
	items := make([]Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		items = append(items, copyJob(job))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items, nil
}
func (s *Service) Get(id string) (Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return Job{}, s.fault
	}
	job, ok := s.jobs[id]
	if !ok {
		return Job{}, ErrNotFound
	}
	return copyJob(job), nil
}

func (s *Service) Start(ctx context.Context, input Input) (Job, error) {
	if err := validateInput(&input); err != nil {
		return Job{}, err
	}
	s.mu.Lock()
	if s.fault != nil {
		s.mu.Unlock()
		return Job{}, s.fault
	}
	if s.active != "" || s.preparing {
		s.mu.Unlock()
		return Job{}, ErrBusy
	}
	if err := s.ctx.Err(); err != nil {
		s.mu.Unlock()
		return Job{}, err
	}
	s.preparing = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.preparing = false; s.mu.Unlock() }()
	if !s.runner.Check(ctx).Ready {
		return Job{}, ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return Job{}, err
	}
	bytes := make([]byte, 12)
	if _, err := rand.Read(bytes); err != nil {
		return Job{}, err
	}
	id := "tb-" + hex.EncodeToString(bytes)
	dir := filepath.Join(s.root, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return Job{}, err
	}
	job := Job{ID: id, Suite: input.Suite, Dataset: s.catalog.Dataset, Agent: s.catalog.Agent, HarborVersion: s.catalog.HarborVersion, ServiceName: input.ServiceName, BaseURL: input.BaseURL, Model: input.Model, Protocol: input.Protocol, Concurrency: input.Concurrency, Status: "running", CreatedAt: time.Now().UTC(), Trials: []Trial{}}
	for _, task := range s.catalog.Select(input.Suite) {
		job.Trials = append(job.Trials, Trial{Name: task.Name, Status: "pending"})
	}
	if err := writeJSONFile(filepath.Join(dir, "input.json"), buildConfig(s.catalog, job, dir)); err != nil {
		return Job{}, err
	}
	if err := s.store.Save(job); err != nil {
		return Job{}, err
	}
	s.mu.Lock()
	s.jobs[id] = copyJob(job)
	s.active = id
	runCtx, cancel := context.WithTimeout(s.ctx, 24*time.Hour)
	s.cancel = cancel
	response := copyJob(job)
	s.workers.Go(func() { s.run(runCtx, job, input.APIKey) })
	s.mu.Unlock()
	return response, nil
}
func (s *Service) Cancel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return ErrNotFound
	}
	if s.active != id {
		return nil
	}
	job.Status = "cancelling"
	if err := s.store.Save(job); err != nil {
		return err
	}
	s.jobs[id] = job
	s.cancel()
	return nil
}
func (s *Service) Wait() { s.workers.Wait() }

// Busy reports whether a Harbor job is preparing or running. Local runtime
// cleanup uses this guard before removing the Python/Harbor cache.
func (s *Service) Busy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.preparing || s.active != ""
}

func (s *Service) run(ctx context.Context, job Job, key string) {
	dir := filepath.Join(s.root, job.ID)
	if s.cleanup {
		defer func() {
			if err := os.RemoveAll(dir); err != nil {
				s.mu.Lock()
				s.fault = errors.New("本机临时任务目录清理失败")
				s.mu.Unlock()
			}
		}()
	}
	done := make(chan error, 1)
	go func() { done <- s.runner.Run(ctx, dir, key) }()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var runErr error
wait:
	for {
		select {
		case runErr = <-done:
			break wait
		case <-ticker.C:
			readTrials(dir, &job)
			s.mu.Lock()
			if s.jobs[job.ID].Status == "cancelling" {
				job.Status = "cancelling"
			}
			s.jobs[job.ID] = copyJob(job)
			s.mu.Unlock()
		}
	}
	readTrials(dir, &job)
	now := time.Now().UTC()
	job.FinishedAt = &now
	job.Status = "completed"
	if runErr != nil {
		job.Status = "failed"
		job.Error = "Harbor 运行失败；请检查本机任务目录中的 Harbor 日志。原始错误不会回显。"
	}
	for i := range job.Trials {
		t := &job.Trials[i]
		if t.Status == "pending" || t.Status == "running" {
			t.Status = "error"
			t.Error = "未取得最终 verifier 结果"
		}
		if t.Status == "error" && job.Status == "completed" {
			job.Status = "completed_with_errors"
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil {
		if s.jobs[job.ID].Status == "cancelling" {
			job.Status = "cancelled"
			job.Error = "用户已取消"
		} else if s.ctx.Err() != nil {
			job.Status = "interrupted"
			job.Error = "服务停止，运行被中断"
		} else {
			job.Status = "failed"
			job.Error = "超过本服务 24 小时运行上限"
		}
		for i := range job.Trials {
			if job.Trials[i].Error == "未取得最终 verifier 结果" {
				job.Trials[i].Status = job.Status
				job.Trials[i].Error = job.Error
			}
		}
	}
	if err := s.store.Save(job); err != nil {
		s.fault = errors.New("Terminal Bench 结果保存失败，请检查数据目录")
	}
	s.jobs[job.ID] = copyJob(job)
	s.active = ""
	s.cancel()
	s.cancel = nil
}

func readTrials(dir string, job *Job) {
	files, _ := filepath.Glob(filepath.Join(dir, "harbor", "*", "result.json"))
	known := map[string]int{}
	for i, task := range job.Trials {
		known[task.Name] = i
	}
	for _, file := range files {
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		f, err := os.Open(file)
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, 8<<20))
		f.Close()
		if err != nil {
			continue
		}
		var raw struct {
			Name     string     `json:"task_name"`
			Started  *time.Time `json:"started_at"`
			Finished *time.Time `json:"finished_at"`
			Verifier *struct {
				Rewards map[string]float64 `json:"rewards"`
			} `json:"verifier_result"`
			Exception *struct {
				Type string `json:"exception_type"`
			} `json:"exception_info"`
		}
		// Harbor rewrites files while running. Only consume complete JSON snapshots.
		if json.Unmarshal(data, &raw) != nil {
			continue
		}
		i, ok := known[raw.Name]
		if !ok {
			continue
		}
		trial := Trial{Name: raw.Name, StartedAt: raw.Started, FinishedAt: raw.Finished, Status: "running"}
		if raw.Exception != nil {
			trial.Status = "error"
			trial.Error = "Harbor 运行异常（请查看本机 artifact）"
		}
		if raw.Finished != nil && raw.Exception == nil {
			if raw.Verifier != nil {
				if reward, ok := raw.Verifier.Rewards["reward"]; ok {
					trial.Reward = &reward
					trial.Status = "failed"
					if reward == 1 {
						trial.Status = "passed"
					}
				}
			}
			if trial.Reward == nil {
				trial.Status = "error"
				trial.Error = "任务结束但未返回 reward"
			}
		}
		job.Trials[i] = trial
	}
}
func copyJob(job Job) Job {
	job.Trials = slices.Clone(job.Trials)
	for i := range job.Trials {
		if job.Trials[i].Reward != nil {
			v := *job.Trials[i].Reward
			job.Trials[i].Reward = &v
		}
	}
	return job
}
func validateInput(input *Input) error {
	if input.Suite != "daily" && input.Suite != "full" {
		return fmt.Errorf("%w: suite 必须是 daily 或 full", ErrInvalid)
	}
	if input.Protocol != "chat_completions" && input.Protocol != "responses" && input.Protocol != "messages" {
		return fmt.Errorf("%w: protocol 必须是 chat_completions、responses 或 messages", ErrInvalid)
	}
	if input.Concurrency < 1 || input.Concurrency > 4 {
		return fmt.Errorf("%w: 并发数需为 1–4", ErrInvalid)
	}
	input.Model = strings.TrimSpace(input.Model)
	input.ServiceName = strings.TrimSpace(input.ServiceName)
	if input.Model == "" || len(input.Model) > 200 || strings.ContainsAny(input.Model, "\r\n") {
		return fmt.Errorf("%w: 模型 ID 无效", ErrInvalid)
	}
	if strings.TrimSpace(input.APIKey) == "" || strings.ContainsAny(input.APIKey, "\r\n") {
		return fmt.Errorf("%w: API Key 无效", ErrInvalid)
	}
	base, err := url.Parse(strings.TrimSpace(input.BaseURL))
	if err != nil || base.Hostname() == "" || (base.Scheme != "http" && base.Scheme != "https") || base.User != nil || base.RawQuery != "" || base.ForceQuery || base.Fragment != "" {
		return fmt.Errorf("%w: API 根地址无效", ErrInvalid)
	}
	input.BaseURL = strings.TrimRight(base.String(), "/")
	if input.ServiceName == "" {
		input.ServiceName = input.BaseURL
	}
	return nil
}
