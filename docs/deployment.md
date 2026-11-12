# LLM Detector 部署手册

本文说明如何将 LLM Detector 部署到一个 HTTPS 域名，并让访问者在自己的电脑上运行本地 Terminal Bench 执行器。

部署后由两个进程组成：

```text
浏览器
  ├─ HTTPS → LLM Detector 云端服务
  └─ HTTP → 用户电脑 127.0.0.1:9002 本机执行器
                    └─ Harbor / Docker / Terminal Bench
```

云端服务负责页面、账号、云端数据和 API 路由。本机执行器只负责用户主动选择的本地模型请求和 Terminal Bench 任务。

## 1. 准备服务器

服务器需要：

- Go 1.26+
- Node.js 22.12+
- npm
- Git
- 反向代理，例如 Caddy 或 Nginx
- 如果云端要运行 Terminal Bench，还需要 Docker、Docker Compose、Python 3.12 和 Harbor

进入项目根目录：

```bash
cd /opt/llm-detector
make install
make init-env
```

`make init-env` 会生成根目录 `.env`。首次部署至少需要设置云端初始账号：

```dotenv
APP_LOGIN_KEY=替换为随机访问密钥
CLOUD_ADMIN_USERNAME=admin
CLOUD_ADMIN_PASSWORD=仅用于新数据库初始化的内部密码
HTTP_ADDR=127.0.0.1:9001
WEB_DIST_DIR=web/dist
DATA_DIR=data
```

不要把 `.env` 放到静态文件目录，不要把 `APP_LOGIN_KEY` 或 `CLOUD_ADMIN_PASSWORD` 写入 Git 或启动命令行。

构建后端、前端和本机执行器压缩包：

```bash
make build
make local-runner-build
```

构建结果包括：

```text
bin/server
web/dist/
dist/local-runner/llm-detector-local-*.zip
```

云端服务可以直接由 Go 同源托管前端：

```bash
./bin/server
```

`WEB_DIST_DIR=web/dist` 必须相对于服务的工作目录解析，因此使用 systemd 时必须设置 `WorkingDirectory`。

## 2. 使用 Caddy 配置域名

假设正式域名是：

```text
detector.example.com
```

Caddy 配置：

```caddyfile
detector.example.com {
    reverse_proxy 127.0.0.1:9001
}
```

Caddy 会自动申请和续期 HTTPS 证书。启动后验证：

```bash
curl -fsS https://detector.example.com/healthz
```

预期返回：

```json
{"status":"ok"}
```

如果使用 Nginx，可以配置：

```nginx
server {
    listen 443 ssl http2;
    server_name detector.example.com;

    ssl_certificate     /etc/letsencrypt/live/detector.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/detector.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

不要把 9001 直接暴露到公网。公网入口应该是 HTTPS 反向代理，Go 服务只监听 `127.0.0.1:9001`。

## 3. 使用 systemd 启动云端服务

创建 `/etc/systemd/system/llm-detector.service`：

```ini
[Unit]
Description=LLM Detector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=llm-detector
Group=llm-detector
WorkingDirectory=/opt/llm-detector
ExecStart=/opt/llm-detector/bin/server
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

然后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now llm-detector
sudo systemctl status llm-detector
```

查看日志：

```bash
sudo journalctl -u llm-detector -f
```

服务启动失败时，先确认：

- `WorkingDirectory` 是项目根目录
- 根目录 `.env` 存在且可被服务用户读取
- `WEB_DIST_DIR=web/dist`
- `APP_LOGIN_KEY` 已设置，`CLOUD_ADMIN_USERNAME` 指向目标数据账号（新库初始化还需 `CLOUD_ADMIN_PASSWORD`）
- `data/` 对服务用户可写
- 9001 没有被其他进程占用

## 4. 发布本机执行器下载包

网页通过云端服务的 `/downloads/` 路径提供本机执行器下载。部署前执行：

```bash
make local-runner-build
```

确认文件存在：

```bash
ls dist/local-runner/
```

至少应包含对应用户平台的压缩包，例如：

```text
llm-detector-local-darwin-arm64.zip
llm-detector-local-darwin-amd64.zip
llm-detector-local-linux-amd64.zip
llm-detector-local-windows-amd64.zip
```

页面会根据用户选择的系统和架构请求：

```text
/downloads/llm-detector-local-<platform>-<arch>.zip
```

压缩包是未签名开发构建。正式分发时应通过可信渠道分发，并向用户提供对应的 SHA-256 文件。

## 5. 用户电脑启动执行器并指定域名

用户访问：

```text
https://detector.example.com
```

在页面的「本地执行环境」中选择系统和架构并下载执行器。用户解压后，在终端启动。

macOS / Linux 示例：

```bash
cd ~/Downloads/llm-detector-local
./llm-detector-local --origin https://detector.example.com
```

如果需要允许多个部署来源，可以用逗号分隔：

```bash
./llm-detector-local \
  --origin 'https://detector.example.com,https://www.detector.example.com'
```

也可以使用环境变量：

```bash
LLM_DETECTOR_LOCAL_ORIGINS=https://detector.example.com \
  ./llm-detector-local
```

Windows PowerShell：

```powershell
$env:LLM_DETECTOR_LOCAL_ORIGINS="https://detector.example.com"
.\llm-detector-local.exe
```

如果用户直接双击启动脚本，默认只允许：

```text
http://127.0.0.1:9000
http://localhost:9000
```

对于正式域名，必须使用 `--origin` 或 `LLM_DETECTOR_LOCAL_ORIGINS` 指定域名。来源值只包含协议、域名和端口，不要填写路径：

```text
正确：https://detector.example.com
错误：https://detector.example.com/tasks
```

如果正式页面使用非标准端口，端口也必须写入来源：

```text
https://detector.example.com:8443
```

执行器启动后会监听：

```text
127.0.0.1:9002
```

网页会自动检测这个地址，用户点击「连接本机执行器」即可建立本地会话，不再需要复制配对码。

## 6. 本机 Terminal Bench 依赖

本机执行器连接成功后，在页面点击「检查本机环境」。检查项包括：

- Harbor
- Docker
- Docker Compose
- Git

页面上的「安装 Python / Harbor 依赖」只会在用户电脑上安装固定版本的 Python / Harbor 依赖，不会安装 Docker 或 Git，也不会自动启动模型测试。

用户需要自行安装并启动：

- Docker Desktop 或 Docker Engine
- Docker Compose
- Git

确认环境就绪后，用户可以进入「巡检引擎」→「Terminal Bench」，选择模型、协议和测试集，主动启动任务。

本机模式不支持服务端定时巡检。执行器退出后，正在运行的本地任务会中断，不会自动迁移到云端。

## 7. 验证本机连接

用户启动执行器后，可以在浏览器开发者工具中确认：

```text
http://127.0.0.1:9002/healthz
```

浏览器页面不应直接在地址栏打开这个接口来判断，因为执行器会校验页面 `Origin`。正确验证方式是：

1. 页面打开「本地执行环境」。
2. 等待显示“已发现本机执行器”。
3. 点击「连接本机执行器」。
4. 看到“本机执行器已连接”。
5. 点击「检查本机环境」。

如果连接失败，依次检查：

- 执行器是否仍在运行
- 启动参数中的 `--origin` 是否与浏览器地址栏完全一致
- 是否包含错误的路径、尾部路径或端口
- 浏览器是否阻止了访问本机网络
- 9002 是否被其他进程占用

常见来源配置：

| 页面地址 | 启动参数 |
| --- | --- |
| `http://127.0.0.1:9000` | 默认即可 |
| `http://localhost:9000` | 默认即可 |
| `https://detector.example.com` | `--origin https://detector.example.com` |
| `https://www.detector.example.com` | `--origin https://www.detector.example.com` |
| `https://detector.example.com:8443` | `--origin https://detector.example.com:8443` |

## 8. 断开与删除本机依赖

本机执行环境页面提供：

- 「断开连接」：删除当前浏览器到执行器的会话。
- 「删除 Python / Harbor 依赖」：删除本机 Python、uv 和 Harbor 缓存。

删除依赖不会删除：

- Docker
- Git
- 浏览器 IndexedDB 中的项目和模型 API 配置
- Terminal Bench 历史结果

Terminal Bench 正在运行或依赖正在安装时，不允许删除依赖。删除后可以再次点击「安装 Python / Harbor 依赖」。

## 9. 来源白名单的安全边界

无配对码模式使用页面来源白名单作为本机执行器的安全边界。执行器只接受：

- 回环 Host，例如 `127.0.0.1:9002`
- 已通过 `--origin` 或 `LLM_DETECTOR_LOCAL_ORIGINS` 配置的页面来源

不要将来源配置为不受信任的站点，也不要实现通配来源。只有你信任的部署域名才能调用本机执行器。

如果域名迁移，用户需要使用新的域名重新启动执行器：

```bash
./llm-detector-local --origin https://new-detector.example.com
```

## 10. 升级流程

云端服务升级：

```bash
git pull
make install
make build
sudo systemctl restart llm-detector
```

本机执行器升级：

1. 重新执行 `make local-runner-build`。
2. 重新下载对应平台的压缩包。
3. 关闭旧执行器。
4. 启动新执行器并保留相同的 `--origin` 配置。
5. 在网页点击「连接本机执行器」。

不要在运行中的执行器目录直接覆盖二进制；先停止旧进程，再替换文件。

网页登录只需要 `APP_LOGIN_KEY`。用户名与初始化密码不显示在网页登录表单中。
