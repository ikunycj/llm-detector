#!/bin/sh
set -eu
# Usage: sh install-worker.sh https://your-detector.example
base=${1:?请提供 LLM Detector 网页地址}
case "$base" in http://*|https://*) ;; *) echo '页面地址必须是 HTTP(S)' >&2; exit 1;; esac
base=${base%/}
[ "$(uname -s)" = Linux ] || { echo '此脚本用于 Linux；其他系统请下载 zip 并运行 start 文件。' >&2; exit 1; }
case "$(uname -m)" in x86_64) arch=amd64;; aarch64|arm64) arch=arm64;; *) echo '暂不支持此 CPU 架构' >&2; exit 1;; esac
for command in curl unzip sha256sum openssl; do command -v "$command" >/dev/null || { echo "请先安装 $command" >&2; exit 1; }; done
root=${LLM_DETECTOR_WORKER_DIR:-"$HOME/.local/share/llm-detector-worker"}
mkdir -p "$root"
chmod 700 "$root"
cd "$root"
# Avoid replacing a running executable or stopping an unrelated process.
if [ -f worker.pid ] && kill -0 "$(cat worker.pid)" 2>/dev/null; then
  echo "Worker 已在运行。更新前请先停止该 Worker；数据和密钥位于 $root。"
  exit 0
fi
name=llm-detector-worker-linux-$arch.zip
curl --fail --location --silent --show-error "$base/downloads/$name" -o "$name"
curl --fail --location --silent --show-error "$base/downloads/$name.sha256" -o "$name.sha256"
sha256sum -c "$name.sha256"
unzip -o "$name" llm-detector-worker start.sh README.txt >/dev/null
chmod +x llm-detector-worker start.sh
if [ ! -f worker.env ]; then
  umask 077
  key=$(openssl rand -hex 32)
  {
    printf 'WORKER_KEY=%s\n' "$key"
    printf 'HTTP_ADDR=0.0.0.0:9003\n'
    printf 'DATA_DIR=worker-data\n'
    printf 'WORKER_ORIGINS=%s\n' "$base"
  } > worker.env
fi
nohup ./llm-detector-worker > worker.log 2>&1 &
pid=$!
printf '%s\n' "$pid" > worker.pid
sleep 1
if ! kill -0 "$pid" 2>/dev/null; then echo "启动失败，请查看 $root/worker.log" >&2; exit 1; fi
echo "Worker 已在后台启动（PID $pid）。配置与数据：$root"
echo '在服务器为 9003 配置 HTTPS 反向代理，再将地址和 worker.env 中的 WORKER_KEY 填到网页。'
echo '重启机器后运行此脚本可再次启动；此脚本不会安装系统服务。'
