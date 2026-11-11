package terminalbench

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Runner keeps Harbor optional. No provider SDK or Python runtime is imported by Go.
type Runner interface {
	Check(context.Context) Readiness
	Run(context.Context, string, string) error
}

type HarborRunner struct {
	Binary  string
	Version string
}

func NewHarborRunner(binary, version string) (*HarborRunner, error) {
	absolute, err := filepath.Abs(binary)
	if err != nil {
		return nil, err
	}
	return &HarborRunner{Binary: absolute, Version: version}, nil
}
func (r *HarborRunner) Check(ctx context.Context) Readiness {
	checks := []Check{}
	for _, item := range []struct {
		name, bin string
		args      []string
		expected  string
	}{
		{"Harbor", r.Binary, []string{"--version"}, r.Version},
		{"Docker", "docker", []string{"info", "--format", "{{.ServerVersion}}"}, ""},
		{"Docker Compose", "docker", []string{"compose", "version", "--short"}, ""},
		{"Git", "git", []string{"--version"}, ""},
	} {
		commandCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		cmd := exec.CommandContext(commandCtx, item.bin, item.args...)
		cmd.Env = runtimeEnv("")
		output, err := cmd.Output()
		cancel()
		result := Check{Name: item.name, Ready: err == nil}
		if err != nil {
			if item.name == "Harbor" {
				result.Detail = "未安装或不可执行；在项目根目录运行 make terminal-bench-install"
			} else if item.name == "Git" {
				result.Detail = "请安装 Git，以获取固定版本任务"
			} else {
				result.Detail = "请启动本机 Docker 并确认当前服务用户可以访问"
			}
		}
		if err == nil {
			result.Detail = strings.TrimSpace(string(output))
			if item.expected != "" && !strings.Contains(result.Detail, item.expected) {
				result.Ready = false
				result.Detail = "Harbor 版本不匹配，要求 " + item.expected
			}
		}
		checks = append(checks, result)
	}
	ready := true
	for _, check := range checks {
		ready = ready && check.Ready
	}
	return Readiness{Ready: ready, Checks: checks}
}

func (r *HarborRunner) Run(ctx context.Context, dir, key string) error {
	cmd := exec.Command(r.Binary, "run", "--config", filepath.Join(dir, "input.json"))
	cmd.Dir = dir
	cmd.Env = runtimeEnv(key)
	// Harbor maintains its own local artifacts. Do not relay stdout/stderr or
	// model/provider exception text into our logs or HTTP responses.
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return errors.New("无法启动 Harbor，请检查运行环境")
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		// Harbor handles SIGINT by cancelling trials and cleaning up containers.
		_ = cmd.Process.Signal(os.Interrupt)
		timer := time.NewTimer(45 * time.Second)
		defer timer.Stop()
		select {
		case <-done:
		case <-timer.C:
			_ = cmd.Process.Kill()
			<-done
		}
		return ctx.Err()
	}
}

func runtimeEnv(key string) []string {
	// Never propagate the app login key, unrelated provider credentials, or
	// arbitrary terminal environment into Harbor. The model key is process-only.
	allowed := []string{"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"}
	env := []string{"PYTHONUNBUFFERED=1", "LITELLM_TELEMETRY=False", "DO_NOT_TRACK=1", "HARBOR_TELEMETRY=0"}
	for _, name := range allowed {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	if key != "" {
		env = append(env, "TB_MODEL_API_KEY="+key)
	}
	return env
}

func buildConfig(c Catalog, job Job, dir string) map[string]any {
	tasks := []map[string]any{}
	for _, task := range c.Select(job.Suite) {
		tasks = append(tasks, map[string]any{"path": task.Path, "git_url": task.GitURL, "git_commit_id": task.Commit, "source": c.Dataset})
	}
	format := "openai_chat_completions"
	switch job.Protocol {
	case "responses":
		format = "openai_responses"
	case "messages":
		format = "anthropic_messages"
	}
	return map[string]any{
		"job_name": "harbor", "jobs_dir": dir, "n_attempts": 1, "n_concurrent_trials": job.Concurrency,
		"quiet": true, "retry": map[string]any{"max_retries": 0},
		"environment": map[string]any{"type": "docker", "delete": true},
		"agents":      []any{map[string]any{"name": c.Agent, "model_name": job.Model, "base_url": job.BaseURL, "model_api_key_name": "TB_MODEL_API_KEY", "model_api_format": format, "skip_model_parsing": true}},
		"tasks":       tasks,
	}
}

func writeJSONFile(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".tb-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, werr := file.Write(data)
	serr := file.Sync()
	cerr := file.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		return err
	}
	return os.Rename(file.Name(), path)
}
