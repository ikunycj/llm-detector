package localruntime

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	benchenv "llm-detector/extensions/terminal-bench"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type Installer struct {
	mu      sync.Mutex
	Root    string
	Running bool
	Error   string
	workers sync.WaitGroup
}

func (i *Installer) State() map[string]any {
	i.mu.Lock()
	defer i.mu.Unlock()
	return map[string]any{"running": i.Running, "error": i.Error}
}
func (i *Installer) Start(ctx context.Context) bool {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.Running {
		return false
	}
	i.Running = true
	i.Error = ""
	i.workers.Go(func() {
		err := i.install(ctx)
		i.mu.Lock()
		defer i.mu.Unlock()
		i.Running = false
		if err != nil {
			i.Error = err.Error()
		}
	})
	return true
}
func (i *Installer) Wait() { i.workers.Wait() }

func (i *Installer) Remove() error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.Running {
		return errors.New("依赖安装正在进行，请等待完成")
	}
	if err := os.RemoveAll(i.Root); err != nil {
		return errors.New("删除本机 Harbor 依赖失败")
	}
	i.Error = ""
	return nil
}
func HarborBinary(root string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(root, ".venv", "Scripts", "harbor.exe")
	}
	return filepath.Join(root, ".venv", "bin", "harbor")
}
func (i *Installer) install(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	if err := os.MkdirAll(i.Root, 0700); err != nil {
		return errors.New("无法创建本机依赖目录")
	}
	for name, data := range map[string][]byte{"pyproject.toml": benchenv.Project, "uv.lock": benchenv.Lock} {
		if err := os.WriteFile(filepath.Join(i.Root, name), data, 0600); err != nil {
			return errors.New("无法写入依赖清单")
		}
	}
	uv, err := exec.LookPath("uv")
	if err != nil {
		uv, err = downloadUV(ctx, i.Root)
		if err != nil {
			return err
		}
	}
	cmd := exec.CommandContext(ctx, uv, "sync", "--project", i.Root, "--locked", "--python", "3.12")
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	for _, name := range []string{"PATH", "HOME", "USERPROFILE", "SystemRoot", "TMPDIR", "TMP", "TEMP", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"} {
		if v, ok := os.LookupEnv(name); ok {
			cmd.Env = append(cmd.Env, name+"="+v)
		}
	}
	cmd.Env = append(cmd.Env, "DO_NOT_TRACK=1", "UV_PYTHON_INSTALL_DIR="+filepath.Join(i.Root, "python"))
	if err := cmd.Run(); err != nil {
		return errors.New("Harbor 依赖安装失败，请检查网络和 Python 3.12 支持；可在终端运行 uv sync --locked --python 3.12")
	}
	return nil
}
func downloadUV(ctx context.Context, root string) (string, error) {
	arch := map[string]string{"amd64": "x86_64", "arm64": "aarch64"}[runtime.GOARCH]
	target := map[string]string{"darwin": "apple-darwin", "linux": "unknown-linux-gnu", "windows": "pc-windows-msvc"}[runtime.GOOS]
	if arch == "" || target == "" {
		return "", errors.New("此平台需要手动安装 uv")
	}
	name := "uv-" + arch + "-" + target
	ext := ".tar.gz"
	binary := "uv"
	if runtime.GOOS == "windows" {
		ext = ".zip"
		binary = "uv.exe"
	}
	base := "https://github.com/astral-sh/uv/releases/download/0.13.7/" + name + ext
	fetch := func(url string, limit int64) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
		if err != nil {
			return nil, err
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return nil, err
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			return nil, errors.New("download failed")
		}
		b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
		if err != nil || int64(len(b)) > limit {
			return nil, errors.New("download too large")
		}
		return b, nil
	}
	checksum, err := fetch(base+".sha256", 4096)
	if err != nil {
		return "", errors.New("无法下载 uv 校验文件，请检查 GitHub 访问")
	}
	archive, err := fetch(base, 100<<20)
	if err != nil {
		return "", errors.New("无法下载 uv，请检查 GitHub 访问")
	}
	fields := strings.Fields(string(checksum))
	digest := sha256.Sum256(archive)
	if len(fields) == 0 || fields[0] != hex.EncodeToString(digest[:]) {
		return "", errors.New("uv 下载校验失败")
	}
	var content []byte
	if ext == ".zip" {
		reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return "", err
		}
		for _, f := range reader.File {
			if filepath.Base(f.Name) == binary {
				r, err := f.Open()
				if err != nil {
					return "", err
				}
				content, err = io.ReadAll(io.LimitReader(r, 100<<20))
				r.Close()
				if err != nil {
					return "", err
				}
				break
			}
		}
	} else {
		gz, err := gzip.NewReader(bytes.NewReader(archive))
		if err != nil {
			return "", err
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			header, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return "", err
			}
			if filepath.Base(header.Name) == binary && header.Typeflag == tar.TypeReg {
				content, err = io.ReadAll(io.LimitReader(tr, 100<<20))
				if err != nil {
					return "", err
				}
				break
			}
		}
	}
	if len(content) == 0 {
		return "", errors.New("uv 压缩包缺少执行文件")
	}
	path := filepath.Join(root, binary)
	if err := os.WriteFile(path, content, 0700); err != nil {
		return "", err
	}
	return path, nil
}
