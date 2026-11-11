package inspection

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"llm-detector/internal/evaluators"
	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/project"
	"llm-detector/pkg/provider"
)

var ErrInvalid = errors.New("配置无效")
var ErrUpstream = errors.New("项目连接失败")

// Runner is the existing scanner; its results contain no connection credentials.
type Runner interface {
	Start(scan.Request) (scan.Scan, error)
	Get(string) (scan.Scan, error)
}

type Service struct {
	mu       sync.Mutex
	ctx      context.Context
	store    *FileStore
	state    state
	adapters map[string]project.Adapter
	scans    Runner
	engines  *evaluators.Registry
	busy     map[string]bool
	workers  sync.WaitGroup
	fault    error
}

func NewService(ctx context.Context, store *FileStore, data state, scans Runner, engines *evaluators.Registry, adapters ...project.Adapter) (*Service, error) {
	registry := make(map[string]project.Adapter, len(adapters))
	for _, adapter := range adapters {
		if _, ok := registry[adapter.ID()]; ok {
			return nil, fmt.Errorf("duplicate project adapter %s", adapter.ID())
		}
		registry[adapter.ID()] = adapter
	}
	s := &Service{ctx: ctx, store: store, state: data, adapters: registry, scans: scans, engines: engines, busy: map[string]bool{}}
	now := time.Now().UTC()
	for i := range s.state.Runs {
		run := &s.state.Runs[i]
		if run.Status == "running" {
			run.Status = "interrupted"
			run.Error = "服务重启中断了该批次；不会自动补跑"
			run.CompletedAt = &now
			for j := range run.Items {
				if run.Items[j].Status == "pending" || run.Items[j].Status == "running" {
					run.Items[j].Status = "interrupted"
				}
			}
		}
	}
	for id, raw := range s.state.Projects {
		raw.View.Busy = false
		for _, engineID := range raw.View.Plan.Evaluators {
			if _, ok := engines.Get(engineID); !ok {
				raw.View.Plan.Enabled = false
				raw.View.NextRunAt = nil
				raw.View.LastError = "计划包含已停用引擎，请在设置中重新选择并保存"
				break
			}
		}
		if raw.View.Plan.Enabled {
			next := now.Add(time.Duration(raw.View.Plan.IntervalMinutes) * time.Minute)
			raw.View.NextRunAt = &next
		}
		s.state.Projects[id] = raw
	}
	if err := store.Save(s.state); err != nil {
		return nil, err
	}
	return s, nil
}

// commit is called with mu held. Public mutations become visible only after save.
func (s *Service) commit(next state) error {
	if err := s.store.Save(next); err != nil {
		return err
	}
	s.state = cloneState(next)
	return nil
}
func (s *Service) available(id string) (diskProject, error) {
	if s.fault != nil {
		return diskProject{}, s.fault
	}
	raw, ok := s.state.Projects[id]
	if !ok {
		return diskProject{}, ErrNotFound
	}
	if s.busy[id] {
		return diskProject{}, ErrBusy
	}
	return raw, nil
}
func (s *Service) view(raw diskProject) Project { v := raw.View; v.Busy = s.busy[v.ID]; return v }

func (s *Service) List() ([]Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return nil, s.fault
	}
	copy := cloneState(s.state)
	items := make([]Project, 0, len(copy.Projects))
	for _, raw := range copy.Projects {
		items = append(items, s.view(raw))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Name < items[j].Name })
	return items, nil
}
func (s *Service) Get(id string) (Project, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, ok := cloneState(s.state).Projects[id]
	if !ok {
		return Project{}, ErrNotFound
	}
	return s.view(raw), s.fault
}

func (s *Service) SaveProject(id string, input Input) (Project, error) {
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" || len([]rune(input.Name)) > 100 {
		return Project{}, invalid("项目名称需为 1-100 字符")
	}
	if _, ok := s.adapters[input.Kind]; !ok {
		return Project{}, invalid("项目类型未注册")
	}
	base, err := validateURL(input.BaseURL)
	if err != nil {
		return Project{}, err
	}
	if input.UserID <= 0 {
		return Project{}, invalid("New API User ID 必须为正整数")
	}
	input.AccessToken = strings.TrimSpace(strings.TrimPrefix(input.AccessToken, "Bearer "))
	if strings.ContainsAny(input.AccessToken, "\r\n") {
		return Project{}, invalid("Access Token 不得包含换行")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return Project{}, s.fault
	}
	var raw diskProject
	if id != "" {
		raw, err = s.available(id)
		if err != nil {
			return Project{}, err
		}
		if (raw.View.BaseURL != base || raw.View.UserID != input.UserID || raw.View.Kind != input.Kind) && input.AccessToken == "" {
			return Project{}, invalid("修改目标地址、类型或 User ID 时需要重新填写 Access Token")
		}
	} else {
		id, err = newID("project")
		if err != nil {
			return Project{}, err
		}
		raw = diskProject{View: Project{ID: id, Channels: []ChannelView{}, Groups: []string{}, Plan: Plan{Mode: "channels", Groups: []string{}, ChannelIDs: []string{}, Models: []string{}, Evaluators: s.engines.DefaultIDs(), IntervalMinutes: 60}}, Keys: map[string]string{}}
	}
	if input.AccessToken == "" {
		input.AccessToken = raw.AccessToken
	}
	if input.AccessToken == "" {
		return Project{}, invalid("请填写 New API 管理员 Access Token")
	}
	if raw.View.BaseURL != base || raw.AccessToken != input.AccessToken || raw.View.UserID != input.UserID || raw.View.Kind != input.Kind {
		raw.View.Channels = []ChannelView{}
		raw.View.Groups = []string{}
		raw.View.SyncedAt = nil
		raw.Keys = map[string]string{}
		raw.View.Plan.Enabled = false
		raw.View.NextRunAt = nil
	}
	raw.View.Name, raw.View.Kind, raw.View.BaseURL, raw.View.UserID = input.Name, input.Kind, base, input.UserID
	raw.View.AdminAccount = input.AdminAccount
	raw.AccessToken = input.AccessToken
	raw.View.HasToken = true
	raw.View.LastError = ""
	next := cloneState(s.state)
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return s.view(raw), nil
}
func (s *Service) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.available(id); err != nil {
		return err
	}
	next := cloneState(s.state)
	delete(next.Projects, id)
	// Keep already completed, credential-free run snapshots for review.
	return s.commit(next)
}

func (s *Service) begin(id string) (diskProject, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.available(id)
	if err == nil {
		s.busy[id] = true
	}
	return raw, err
}
func (s *Service) release(id string) { s.mu.Lock(); delete(s.busy, id); s.mu.Unlock() }
func connection(raw diskProject) project.Connection {
	return project.Connection{BaseURL: raw.View.BaseURL, AccessToken: raw.AccessToken, UserID: raw.View.UserID}
}

// Sync refreshes metadata only. Keys remain bound to the same channel URL/protocol.
func (s *Service) Sync(ctx context.Context, id string) (Project, error) {
	ctx, cancel := s.operationContext(ctx)
	defer cancel()
	raw, err := s.begin(id)
	if err != nil {
		return Project{}, err
	}
	defer s.release(id)
	channels, err := s.adapters[raw.View.Kind].Discover(ctx, connection(raw))
	if err != nil {
		return Project{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	raw = mergeChannels(raw, channels)
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return raw.View, nil
}

// ImportKeys refreshes metadata before asking the official key endpoint. Codes
// and verification cookies live only inside this call; no 2FA seed is stored.
func (s *Service) ImportKeys(ctx context.Context, id string, ids []string, code string) (Project, error) {
	ctx, cancel := s.operationContext(ctx)
	defer cancel()
	if len(ids) == 0 {
		return Project{}, invalid("请选择要导入密钥的渠道")
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return Project{}, invalid("导入渠道密钥时必须填写 2FA 验证码")
	}
	if len(code) != 6 || strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return Project{}, invalid("2FA 验证码需为 6 位数字")
	}
	raw, err := s.begin(id)
	if err != nil {
		return Project{}, err
	}
	defer s.release(id)
	adapter := s.adapters[raw.View.Kind]
	channels, err := adapter.Discover(ctx, connection(raw))
	if err != nil {
		return Project{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	selected := []project.Channel{}
	for _, ch := range channels {
		if wanted[ch.ID] {
			if ch.Issue != "" || !ch.Enabled {
				return Project{}, invalid("所选渠道包含停用或不支持的渠道")
			}
			selected = append(selected, ch)
			delete(wanted, ch.ID)
		}
	}
	if len(wanted) > 0 {
		return Project{}, invalid("部分所选渠道已不存在，请重新同步")
	}
	keys, failures, err := adapter.ImportKeys(ctx, connection(raw), selected, code)
	if err != nil {
		return Project{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	raw = mergeChannels(raw, channels)
	for i := range raw.View.Channels {
		ch := &raw.View.Channels[i]
		if key, ok := keys[ch.ID]; ok {
			raw.Keys[ch.ID] = key
			ch.HasKey = true
			ch.KeyError = ""
		}
		if reason, ok := failures[ch.ID]; ok {
			delete(raw.Keys, ch.ID)
			ch.HasKey = false
			ch.KeyError = reason
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return raw.View, nil
}

func mergeChannels(raw diskProject, channels []project.Channel) diskProject {
	old := map[string]ChannelView{}
	for _, ch := range raw.View.Channels {
		old[ch.ID] = ch
	}
	keys := map[string]string{}
	views := make([]ChannelView, 0, len(channels))
	groups := []string{}
	for _, ch := range channels {
		previous, ok := old[ch.ID]
		if ok && previous.BaseURL == ch.BaseURL && previous.Protocol == ch.Protocol && ch.Issue == "" {
			if key := raw.Keys[ch.ID]; key != "" {
				keys[ch.ID] = key
			}
		}
		protocol := previous.ProtocolOverride
		if !ok && ch.Protocol == "" {
			protocol = "chat_completions"
		}
		ch.KeyStatus = nil
		views = append(views, ChannelView{Channel: ch, ProtocolOverride: protocol, HasKey: keys[ch.ID] != ""})
		for _, g := range ch.Groups {
			if !slices.Contains(groups, g) {
				groups = append(groups, g)
			}
		}
	}
	sort.Strings(groups)
	now := time.Now().UTC()
	raw.Keys = keys
	raw.View.Channels = views
	raw.View.Groups = groups
	raw.View.SyncedAt = &now
	raw.View.LastError = ""
	return raw
}

// UpdateChannelProtocol only changes this service's test configuration, never
// the upstream channel. An empty override follows the discovered protocol.
func (s *Service) UpdateChannelProtocol(id, channelID, protocol string) (Project, error) {
	if protocol != "" && protocol != "chat_completions" && protocol != "responses" && protocol != "messages" {
		return Project{}, invalid("测试协议必须为 chat_completions、responses、messages，或留空跟随渠道")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.available(id); err != nil {
		return Project{}, err
	}
	next := cloneState(s.state)
	raw := next.Projects[id]
	found := false
	for i := range raw.View.Channels {
		if raw.View.Channels[i].ID == channelID {
			raw.View.Channels[i].ProtocolOverride = protocol
			found = true
			break
		}
	}
	if !found {
		return Project{}, invalid("渠道不存在，请重新同步")
	}
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return s.view(raw), nil
}

func (s *Service) UpdatePlan(id string, plan Plan) (Project, error) {
	if plan.Mode != "all" && plan.Mode != "groups" && plan.Mode != "channels" {
		return Project{}, invalid("范围必须是 all、groups 或 channels")
	}
	if plan.IntervalMinutes < 1 || plan.IntervalMinutes > 10080 {
		return Project{}, invalid("巡检间隔需为 1-10080 分钟")
	}
	plan.Groups = unique(plan.Groups)
	plan.ChannelIDs = unique(plan.ChannelIDs)
	plan.Models = unique(plan.Models)
	plan.Evaluators = unique(plan.Evaluators)
	if len(plan.Evaluators) == 0 {
		return Project{}, invalid("至少选择一个巡检引擎")
	}
	for id := range plan.EvaluatorOptions {
		if !slices.Contains(plan.Evaluators, id) {
			return Project{}, invalid("检测参数必须属于已选引擎")
		}
	}
	for _, id := range plan.Evaluators {
		engine, ok := s.engines.Get(id)
		if !ok {
			return Project{}, invalid("所选巡检引擎未注册")
		}
		options := plan.EvaluatorOptions[id]
		if len(options) > 0 {
			var fields map[string]json.RawMessage
			if json.Unmarshal(options, &fields) != nil || fields == nil {
				return Project{}, invalid("检测参数必须为 JSON 对象")
			}
		}
		if len(options) > 0 {
			if validator, ok := engine.(evaluator.OptionsValidator); ok {
				if err := validator.ValidateOptions(options); err != nil {
					return Project{}, invalid(err.Error())
				}
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.available(id)
	if err != nil {
		return Project{}, err
	}
	if plan.Mode == "groups" && (len(plan.Groups) == 0 || !allIn(plan.Groups, raw.View.Groups)) {
		return Project{}, invalid("请选择有效分组")
	}
	known := []string{}
	for _, ch := range raw.View.Channels {
		known = append(known, ch.ID)
	}
	if plan.Mode == "channels" && (len(plan.ChannelIDs) == 0 || !allIn(plan.ChannelIDs, known)) {
		return Project{}, invalid("请选择有效渠道")
	}
	if len(selectChannels(raw.View.Channels, plan)) == 0 {
		return Project{}, invalid("当前范围没有启用的渠道")
	}
	if plan.Enabled {
		usable := false
		for _, ch := range selectChannels(raw.View.Channels, plan) {
			usable = usable || (ch.HasKey && ch.Issue == "")
		}
		if !usable {
			return Project{}, invalid("请先为至少一个可用渠道导入密钥，再启用定时巡检")
		}
	}
	raw.View.Plan = plan
	raw.View.LastError = ""
	raw.View.NextRunAt = nil
	if plan.Enabled {
		next := time.Now().UTC().Add(time.Duration(plan.IntervalMinutes) * time.Minute)
		raw.View.NextRunAt = &next
	}
	next := cloneState(s.state)
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return raw.View, nil
}

func (s *Service) Run(id, trigger string) (Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := s.available(id)
	if err != nil {
		return Run{}, err
	}
	if err = s.ctx.Err(); err != nil {
		return Run{}, err
	}
	plan := raw.View.Plan
	if len(plan.Evaluators) == 0 {
		return Run{}, invalid("请先保存巡检计划")
	}
	for _, engineID := range plan.Evaluators {
		if _, ok := s.engines.Get(engineID); !ok {
			return Run{}, invalid("计划包含已停用引擎，请在设置中重新选择并保存")
		}
	}
	channels := selectChannels(raw.View.Channels, plan)
	if len(channels) == 0 {
		return Run{}, invalid("当前范围没有启用的渠道，请同步并保存计划")
	}
	idRun, err := newID("batch")
	if err != nil {
		return Run{}, err
	}
	run := Run{ID: idRun, ProjectID: id, ProjectName: raw.View.Name, Trigger: trigger, Status: "running", CreatedAt: time.Now().UTC(), Items: []RunItem{}}
	for _, ch := range channels {
		models := ch.Models
		if len(plan.Models) > 0 {
			models = []string{}
			for _, m := range plan.Models {
				if slices.Contains(ch.Models, m) {
					models = append(models, m)
				}
			}
		}
		for _, engine := range plan.Evaluators {
			protocol := ch.Protocol
			if ch.ProtocolOverride != "" {
				protocol = ch.ProtocolOverride
			}
			run.Items = append(run.Items, RunItem{ChannelID: ch.ID, ChannelName: ch.Name, Groups: ch.Groups, Evaluator: engine, Protocol: protocol, Models: models, Status: "pending"})
		}
	}
	next := cloneState(s.state)
	next.Runs = append([]Run{run}, next.Runs...)
	// Retain the newest 50 batches for each project, preserving active batches.
	counts := map[string]int{}
	retained := []Run{}
	for _, item := range next.Runs {
		counts[item.ProjectID]++
		if counts[item.ProjectID] <= 50 || item.Status == "running" {
			retained = append(retained, item)
		}
	}
	next.Runs = retained
	if err := s.commit(next); err != nil {
		return Run{}, err
	}
	s.busy[id] = true
	s.workers.Go(func() { s.execute(raw, run) })
	return s.state.Runs[0], nil
}

func (s *Service) execute(raw diskProject, run Run) {
	defer s.release(raw.View.ID)
	channels := map[string]ChannelView{}
	for _, ch := range raw.View.Channels {
		channels[ch.ID] = ch
	}
	for i := range run.Items {
		item := &run.Items[i]
		ch := channels[item.ChannelID]
		if s.ctx.Err() != nil {
			item.Status = "interrupted"
			continue
		}
		if ch.Issue != "" {
			item.Status = "error"
			item.Error = ch.Issue
			continue
		}
		if raw.Keys[ch.ID] == "" {
			item.Status = "error"
			item.Error = "渠道没有已导入的 API Key，请在项目卡片导入密钥"
			continue
		}
		if len(item.Models) == 0 {
			item.Status = "error"
			item.Error = "渠道没有符合计划的模型"
			continue
		}
		engine, ok := s.engines.Get(item.Evaluator)
		if !ok {
			item.Status = "error"
			item.Error = "引擎已不可用"
			continue
		}
		options := raw.View.Plan.EvaluatorOptions[item.Evaluator]
		if item.Evaluator == "fingerprint" {
			// Channel protocol overrides apply to the fingerprint SDK too.
			fields := map[string]json.RawMessage{}
			if len(options) > 0 {
				if err := json.Unmarshal(options, &fields); err != nil {
					item.Status, item.Error = "error", "指纹检测参数无效"
					continue
				}
			}
			fields["api"], _ = json.Marshal(item.Protocol)
			options, _ = json.Marshal(fields)
		}
		if validator, ok := engine.(evaluator.OptionsValidator); ok {
			if err := validator.ValidateOptions(options); err != nil {
				item.Status = "error"
				item.Error = "引擎选项不兼容"
				continue
			}
		}
		item.Status = "running"
		if !s.persistRun(run, false) {
			return
		}
		result, err := s.scans.Start(scan.Request{Vendor: "openai-compatible", ServiceName: raw.View.Name + " / " + ch.Name, Scope: "selected", Models: item.Models, Evaluator: item.Evaluator, Options: options, Connection: provider.Connection{BaseURL: ch.BaseURL, APIKey: raw.Keys[ch.ID], Protocol: item.Protocol, Organization: ch.Organization}})
		if err != nil {
			item.Status = "error"
			item.Error = "创建渠道巡检失败"
			continue
		}
		item.ScanID = result.ID
		if !s.persistRun(run, false) {
			return
		}
		result, err = s.waitScan(result.ID)
		if err != nil {
			item.Status = "interrupted"
			item.Error = "服务停止或无法读取扫描结果"
		} else {
			item.Result = &result
			item.Status = result.Status
			item.Error = result.Error
		}
		if !s.persistRun(run, false) {
			return
		}
	}
	run.Status = "completed"
	for _, item := range run.Items {
		if item.Status == "error" || item.Status == "failed" || item.Status == "completed_with_errors" || item.Status == "interrupted" {
			run.Status = "completed_with_errors"
		}
	}
	if s.ctx.Err() != nil {
		run.Status = "interrupted"
		run.Error = "服务停止，批次未执行完；不会自动补跑"
	}
	now := time.Now().UTC()
	run.CompletedAt = &now
	s.persistRun(run, true)
}

func (s *Service) waitScan(id string) (scan.Scan, error) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		item, err := s.scans.Get(id)
		if err != nil {
			return scan.Scan{}, err
		}
		if item.Status != "pending" && item.Status != "running" {
			return item, nil
		}
		select {
		case <-s.ctx.Done():
			return item, s.ctx.Err()
		case <-ticker.C:
		}
	}
}
func (s *Service) persistRun(run Run, finished bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	for i := range next.Runs {
		if next.Runs[i].ID == run.ID {
			next.Runs[i] = run
			break
		}
	}
	if finished {
		if raw, ok := next.Projects[run.ProjectID]; ok {
			raw.View.LastError = run.Error
			if raw.View.Plan.Enabled {
				nextTime := time.Now().UTC().Add(time.Duration(raw.View.Plan.IntervalMinutes) * time.Minute)
				raw.View.NextRunAt = &nextTime
			}
			next.Projects[run.ProjectID] = raw
		}
	}
	if err := s.commit(next); err != nil {
		s.fault = errors.New("巡检存储写入失败，已停止调度；请修复存储后重启服务")
		log.Print(s.fault)
		return false
	}
	return true
}
func (s *Service) Runs(id string) ([]Run, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return nil, s.fault
	}
	items := []Run{}
	for _, run := range cloneState(s.state).Runs {
		if id == "" || run.ProjectID == id {
			items = append(items, run)
		}
	}
	return items, nil
}
func (s *Service) Tick(now time.Time) {
	s.mu.Lock()
	due := []string{}
	if s.fault == nil {
		for id, raw := range s.state.Projects {
			if raw.View.Plan.Enabled && !s.busy[id] && raw.View.NextRunAt != nil && !now.Before(*raw.View.NextRunAt) {
				due = append(due, id)
			}
		}
	}
	s.mu.Unlock()
	for _, id := range due {
		if _, err := s.Run(id, "schedule"); err != nil && !errors.Is(err, ErrBusy) {
			s.mu.Lock()
			if raw, ok := s.state.Projects[id]; ok {
				next := cloneState(s.state)
				raw.View.LastError = err.Error()
				nextTime := now.Add(time.Duration(raw.View.Plan.IntervalMinutes) * time.Minute)
				raw.View.NextRunAt = &nextTime
				next.Projects[id] = raw
				if saveErr := s.commit(next); saveErr != nil {
					s.fault = errors.New("巡检存储失败，已停止调度")
				}
			}
			s.mu.Unlock()
		}
	}
}
func (s *Service) Serve() {
	s.workers.Go(func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case now := <-ticker.C:
				s.Tick(now)
			}
		}
	})
}
func (s *Service) Wait() { s.workers.Wait() }

func selectChannels(channels []ChannelView, plan Plan) []ChannelView {
	out := []ChannelView{}
	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		include := plan.Mode == "all" || plan.Mode == "channels" && slices.Contains(plan.ChannelIDs, ch.ID)
		if plan.Mode == "groups" {
			for _, g := range ch.Groups {
				include = include || slices.Contains(plan.Groups, g)
			}
		}
		if include {
			out = append(out, ch)
		}
	}
	return out
}
func unique(values []string) []string {
	out := []string{}
	for _, v := range values {
		v = strings.TrimSpace(v)
		if v != "" && !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}
func allIn(values, known []string) bool {
	for _, v := range values {
		if !slices.Contains(known, v) {
			return false
		}
	}
	return true
}
func newID(prefix string) (string, error) {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + "-" + hex.EncodeToString(b), nil
}
func invalid(message string) error { return fmt.Errorf("%w: %s", ErrInvalid, message) }
func validateURL(value string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", invalid("项目地址必须是无凭据、查询和片段的 HTTP(S) 根地址")
	}
	u.Path = strings.TrimRight(u.Path, "/")
	return strings.TrimRight(u.String(), "/"), nil
}

// Bound multi-page / multi-key operations and cancel them on server shutdown.
func (s *Service) operationContext(parent context.Context) (context.Context, func()) {
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() { stop(); cancel() }
}

// SaveConnection supports both legacy numeric identity and an account/email
// login used only to resolve and validate the ID. Passwords never reach SaveProject.
func (s *Service) SaveConnection(ctx context.Context, id string, input Input) (Project, error) {
	input.AdminAccount = strings.TrimSpace(input.AdminAccount)
	if input.AdminAccount != "" {
		base, err := validateURL(input.BaseURL)
		if err != nil {
			return Project{}, err
		}
		s.mu.Lock()
		raw, exists := s.state.Projects[id]
		adapter, ok := s.adapters[input.Kind]
		s.mu.Unlock()
		if !ok {
			return Project{}, invalid("项目类型未注册")
		}
		if exists && raw.View.AdminAccount == input.AdminAccount && raw.View.BaseURL == base && raw.View.Kind == input.Kind && input.Password == "" && input.AccessToken == "" {
			input.UserID = raw.View.UserID
		} else {
			if input.Password == "" {
				return Project{}, invalid("通过账号/邮箱识别管理员时，请填写一次登录密码（不保存）")
			}
			if input.AccessToken == "" && exists && raw.View.BaseURL == base {
				input.AccessToken = raw.AccessToken
			}
			if input.AccessToken == "" {
				return Project{}, invalid("请填写该管理员的 Access Token，供后续同步使用")
			}
			resolver, ok := adapter.(project.IdentityResolver)
			if !ok {
				return Project{}, invalid("该项目尚不支持账号解析")
			}
			ctx, cancel := s.operationContext(ctx)
			defer cancel()
			resolved, err := resolver.ResolveUserID(ctx, project.Connection{BaseURL: base, AccessToken: strings.TrimSpace(strings.TrimPrefix(input.AccessToken, "Bearer "))}, input.AdminAccount, input.Password, input.LoginCode)
			if err != nil {
				return Project{}, fmt.Errorf("%w: %v", ErrUpstream, err)
			}
			input.UserID = resolved
		}
	}
	input.Password, input.LoginCode = "", ""
	return s.SaveProject(id, input)
}

// SyncAndImport keeps metadata and per-channel failures even when key
// verification fails. Imported credentials remain strictly server-side.
func (s *Service) SyncAndImport(ctx context.Context, id, code string) (Project, error) {
	ctx, cancel := s.operationContext(ctx)
	defer cancel()
	code = strings.TrimSpace(code)
	if code == "" {
		return Project{}, invalid("导入渠道密钥时必须填写 2FA 验证码")
	}
	if len(code) != 6 || strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
		return Project{}, invalid("2FA 验证码需为 6 位数字")
	}
	raw, err := s.begin(id)
	if err != nil {
		return Project{}, err
	}
	defer s.release(id)
	adapter := s.adapters[raw.View.Kind]
	channels, err := adapter.Discover(ctx, connection(raw))
	if err != nil {
		return Project{}, fmt.Errorf("%w: %v", ErrUpstream, err)
	}
	selected := []project.Channel{}
	for _, ch := range channels {
		if ch.Enabled && ch.Issue == "" {
			selected = append(selected, ch)
		}
	}
	keys, failures := map[string]string{}, map[string]string{}
	if len(selected) > 0 {
		keys, failures, err = adapter.ImportKeys(ctx, connection(raw), selected, code)
		if err != nil {
			keys, failures = map[string]string{}, map[string]string{}
			for _, ch := range selected {
				failures[ch.ID] = err.Error()
			}
		}
	}
	raw = mergeChannels(raw, channels)
	for i := range raw.View.Channels {
		ch := &raw.View.Channels[i]
		if key, ok := keys[ch.ID]; ok {
			raw.Keys[ch.ID] = key
			ch.HasKey = true
			ch.KeyError = ""
		}
		if failure, ok := failures[ch.ID]; ok {
			delete(raw.Keys, ch.ID)
			ch.HasKey = false
			ch.KeyError = failure
		}
	}
	if len(failures) > 0 {
		raw.View.LastError = fmt.Sprintf("元数据同步完成，%d 个渠道密钥导入失败；请查看渠道状态并重试", len(failures))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := cloneState(s.state)
	next.Projects[id] = raw
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return raw.View, nil
}
