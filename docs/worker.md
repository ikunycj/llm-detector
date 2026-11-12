# 自建 Worker

## 从页面添加

任意保存/执行弹框中的「＋ 自建worker」，或顶部「自建worker」，可以填写名称（可选）、地址、密钥。点击「保存并连接」会验证 `/api/v1/worker/info` 和协议版本；连接成功后立即出现在位置选项和数据列表中。

## 本机安装

点击「本机安装worker」，选择操作系统与 CPU，下载 zip。解压并运行 start 文件，首次启动自动创建私有 `worker.env`。默认地址 `http://127.0.0.1:9003`；复制文件中的 `WORKER_KEY` 到网页。若使用已部署网页，将其 origin 加入 `WORKER_ORIGINS` 后重启 Worker。

本机 Worker 9002 的下载入口仍用于“本地执行”选项，不需要添加为自建 Worker。

## Linux 服务器

点击「服务器安装worker」可以复制一条安装命令。脚本下载当前部署提供的 Linux 架构包、校验 SHA-256、解压到 `~/.local/share/llm-detector-worker`，生成密钥并后台启动。

如果页面运行于 localhost，服务器无法通过该 localhost 地址下载。请使用部署后的页面域名运行命令，或把下载的 Linux zip 上传到服务器并运行 start.sh。

安装脚本需要 curl、unzip、sha256sum、openssl。它不覆盖已有 worker.env、数据或密钥，不停止现有进程，不安装系统服务；服务器重启后需重新启动或自行接入进程管理。

自建 Worker 默认不提供 TLS。远程访问时在服务器配置 HTTPS 反向代理至 9003，然后将完整 HTTPS 地址填入网页，避免 HTTPS 页面的混合内容拦截。`WORKER_ORIGINS` 配置允许的网页来源。Worker 密钥是完整访问凭据，不支持多人权限划分。

## 配置

```dotenv
WORKER_KEY=replace-with-your-secret
HTTP_ADDR=127.0.0.1:9003
DATA_DIR=worker-data
WORKER_ORIGINS=http://127.0.0.1:9000,http://localhost:9000
# 可选：使用已有 Harbor
# TERMINAL_BENCH_BINARY=/path/to/harbor
```

源代码启动：

```sh
make worker
```

第一次无需手写配置；`worker.env` 不存在时程序生成随机密钥。已有配置解析失败不会被覆盖。

`worker-data/cloud.sqlite`、`worker-data/cloud.key` 与任务产物目录属于 Worker 的独立数据，应一起备份。正常列表不回显已保存的模型 Key。只有确认跨位置操作才请求 transfer 接口。

## Terminal Bench 依赖

Worker 本体不要求 Python。Terminal Bench 需要 Docker、Git、Python 3.12 和 Harbor。页面「检查环境」选择 Worker 后可安装该 Worker 的 Python / Harbor；Docker 与 Git 由用户安装/启动。安装依赖不启动模型测试。

## 构建下载包

```sh
make local-runner-build
make worker-build
```

生成 macOS、Linux、Windows 的 ARM64 / x64 zip 和校验文件到 `dist/local-runner/`；后端通过 `/downloads/` 提供。部署时需要同时复制此目录。跨平台编译通过不代表对应系统上的 Docker / Harbor 已验证，当前包为未签名开发构建。
