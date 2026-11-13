# LLM Detector

<p align="center">
  <img src="assets/logo/llm-detector-deeptoken-orange-blue.png" alt="LLM Detector" width="220" />
</p>

<p align="center">
  开源的大模型掺水 / 降智监测平台，支持本地和云端两种监测方式。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/README.md">开发文档</a> ·
  <a href="docs/inspection-tasks.md">项目巡检</a> ·
  <a href="https://github.com/ikunycj/llm-detector/issues">反馈问题</a>
</p>

[![Go](https://img.shields.io/badge/Go-1.26%2B-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![React](https://img.shields.io/badge/React-TypeScript-61DAFB?logo=react&logoColor=20232a)](https://react.dev/)

LLM Detector 可以直接检测模型 API，也可以接入 **New API 管理员账户**，同步渠道、导入渠道密钥并批量执行降智巡检。检测结果会区分模型未通过和接口调用错误，便于定位模型能力变化、渠道配置问题和上游服务异常。

> 当前版本已实现本地 / 云端检测、New API 项目接入、批量巡检、定时计划、Fingerpoint 和 Terminal Bench。Sub2API 管理员接入与异常渠道自动停用仍在规划中，当前版本不会自动修改或停用上游渠道。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 本地与云端检测 | 本地模式无需登录，数据保存在当前浏览器；云端模式使用账号登录，数据按账号保存到加密 SQLite。 |
| 直接检测模型 API | 支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages 协议，可检测指定模型或执行模型发现。 |
| New API 项目巡检 | 使用管理员 Access Token 连接 New API，同步分组与渠道，经过安全验证后导入渠道 Key，按分组或渠道批量执行巡检。 |
| Fingerpoint | 基于参考数据进行模型指纹检测和候选排序，用于观察模型特征变化。 |
| Terminal Bench | 使用 Harbor / Terminus-2 执行终端任务，支持日常 6 题和完整 89 题。 |
| 任务与日志 | 支持手动触发、云端间隔调度、批量运行、进度查看和统一巡检日志；Terminal Bench 支持取消。 |
| 可扩展架构 | Provider 负责模型协议，Evaluator 负责检测引擎，项目适配器负责 New API 等外部系统。 |

检测结果使用 `passed`、`failed`、`error` 三类状态。`failed` 表示模型回答没有通过检测，`error` 表示请求、权限、配置或运行环境失败；调用错误不会被伪装成模型能力低分。

## 支持范围

### 模型 API

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- OpenAI 兼容的 `/models` 模型发现
- 指定模型直接检测，不强制依赖模型发现接口

Base URL 按用户填写的地址使用，程序不会自动补 `/v1`。模型列表可能包含 embedding、视觉等当前检测协议不兼容的模型，这些模型会报告调用错误。

### New API

New API 项目连接支持：

1. 保存 New API 地址、管理员 User ID 和 Access Token。
2. 同步项目分组、渠道和可检测模型。
3. 通过管理员当前的 2FA 验证码安全导入渠道 Key。
4. 按分组或渠道选择检测范围、协议和检测引擎。
5. 手动触发批次，或在云端启用间隔计划。

当前直连检测支持 New API 的 OpenAI 类型 `1` 和 Anthropic 类型 `14` 渠道。渠道同步成功不等于 New API 网关路由已经通过检测；检测结果反映的是所选渠道和模型的实际调用情况。

### 当前版本边界

| 能力 | 状态 | 当前行为 |
| --- | --- | --- |
| New API 管理员账户接入 | 已实现 | 支持渠道同步、2FA 密钥导入、分组 / 渠道巡检和云端计划。 |
| Sub2API 管理员账户接入 | 规划中 | 当前代码没有 Sub2API 项目适配器，页面不会伪造可用选项。 |
| 异常渠道自动停用 | 规划中 | 当前只保存并展示结果，不会根据结果调用上游停用接口。 |

## 快速开始

### 环境要求

- Go **1.26+**
- Node.js **22.12+**
- npm

Terminal Bench 还需要 Python 3.12、uv、Docker 等可选依赖；它们不会影响主服务启动。

### 启动开发环境

```bash
git clone https://github.com/ikunycj/llm-detector.git
cd llm-detector

make install
make init-env
```

分别在两个终端启动后端和前端：

```bash
# 终端一：后端，默认 9001
make backend
```

```bash
# 终端二：前端，默认 9000
make frontend
```

打开 <http://127.0.0.1:9000>。Vite 会把 `/api` 和 `/healthz` 代理到 `127.0.0.1:9001`。

`make init-env` 会在缺少 `.env` 时从模板创建开发配置。云端第一次初始化数据库时，可在 `.env` 中设置 `CLOUD_ADMIN_USERNAME` 和 `CLOUD_ADMIN_PASSWORD` 创建初始账号；已有账号不会因为环境变量变化而被覆盖。

### 启动本机执行器

Terminal Bench、New API 项目操作等任务可以由本机执行器完成。执行器只监听回环地址 `127.0.0.1:9002`，不会作为数据保存位置。

```bash
go run ./cmd/local-runner --origin http://127.0.0.1:9000
```

启动后在页面的“本地执行环境”中连接执行器。生产环境的下载包可以使用：

```bash
make local-runner-build
```

### 基本使用流程

1. 在“模型 API”中添加协议、Base URL、API Key 和检测范围。
2. 选择指定模型，或在每次执行时重新发现全部模型。
3. 选择一个或多个检测引擎，再选择本地或云端执行。
4. 查看逐模型进度、检测结果和调用错误。
5. 如需巡检 New API，先在“巡检任务”中添加项目并同步渠道，再导入 Key、配置计划并触发批次。

批量导入模型 API 时使用 JSON 数组，例如：

```json
[
  {
    "name": "研发 API",
    "protocol": "responses",
    "base_url": "https://api.example.com/v1",
    "api_key": "your-key",
    "scope": "selected",
    "models": ["model-a"]
  },
  {
    "name": "备用 API",
    "protocol": "messages",
    "base_url": "https://api.example.org/v1",
    "api_key": "your-key",
    "scope": "all",
    "models": []
  }
]
```

文件只在浏览器内解析，不会上传；批量数据任一项无效时整批不会导入。

## 本地与云端

保存位置和执行位置分别控制数据归属与任务运行环境：

| 操作 | 本地 | 云端 |
| --- | --- | --- |
| 配置与历史 | 当前浏览器的 localStorage / IndexedDB | 当前账号的加密 SQLite |
| Fingerpoint | 浏览器直接调用模型 API | 服务端使用 Go SDK 执行 |
| Terminal Bench | 本机执行器调用 Harbor / Docker | 云端服务调用 Harbor / Docker |
| New API 同步与项目批次 | 本机执行器直连项目或渠道 | 云端服务执行并保存到账号 |
| 间隔计划 | 不支持浏览器离线调度 | 支持云端调度 |

登录不会自动上传本地数据。切换保存位置后保存会创建副本，原记录保留；执行时仍需要单独选择本地或云端。

## Terminal Bench

Terminal Bench 是可选的检测引擎，使用固定题集和 Harbor 环境执行真实终端任务。安装依赖：

```bash
make terminal-bench-install
```

页面提供日常 6 题和完整 89 题两种题集，可配置题目并发数。未安装 Terminal Bench 不影响普通模型检测和主服务启动。完整配置、环境检查和结果语义见 [Terminal Bench 文档](docs/terminal-bench.md)。

## 架构概览

```text
React Web UI
├── 本地模式 ── 浏览器存储 ── 模型 API
│             └────────────── 本机执行器 :9002 ── New API / Harbor
└── 云端模式 ── Go Server :9001 ── 加密 SQLite
                             ├── 模型 API
                             ├── New API
                             └── Harbor / Terminal Bench
```

项目按三类边界组织：

- `pkg/provider`：模型发现和调用协议，不依赖具体厂商 SDK。
- `pkg/evaluator`：检测引擎契约，负责题库、调用编排和结果判定。
- `pkg/project`：外部项目管理适配器，当前内置 New API。

检测引擎和项目适配器通过显式注册接入，具体实现位于 `internal/evaluators` 和 `internal/projects`。扩展约定见 [插件 SDK 文档](docs/plugin-sdk.md)。

## 安全与数据边界

- 云端项目配置、渠道凭据和批次历史保存到按账号隔离的加密 SQLite；普通查询不会回显 API Key 或管理员 Access Token。
- 2FA 验证码只用于本次渠道密钥导入，不保存为长期项目凭据。
- 模型 API Key 不写入任务结果和日志；上游原始错误体不会直接返回给页面。
- 当前项目面向受信任的本地或内部使用者，尚未提供出站地址白名单，不建议直接开放给不可信公网用户。
- 检测结果是特定题集、模型配置和运行环境下的观测证据，不是通用智力分数、模型身份认证或服务可信度证明。

## 构建与验证

```bash
make test
make build
```

需要检查并发存储时运行：

```bash
go test -race ./... -timeout=30s
```

构建后可以让 Go 服务同源托管前端：

```bash
WEB_DIST_DIR=web/dist ./bin/server
```

部署、反向代理和本机执行器发布流程见 [部署手册](docs/deployment.md)。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [开发文档](docs/README.md) | 架构、API、扩展和各功能文档索引 |
| [项目巡检](docs/inspection-tasks.md) | New API 连接、密钥同步、批量与定时巡检 |
| [巡检日志](docs/inspection-logs.md) | 模型任务、项目批次和引擎历史 |
| [本地与云端](docs/local-cloud.md) | 数据保存、执行位置和账号行为 |
| [Fingerpoint](docs/fingerprint-detection.md) | 参考数据、检测配置和结果语义 |
| [Terminal Bench](docs/terminal-bench.md) | Harbor 环境、题集和逐题结果 |
| [架构](docs/architecture.md) | 模块职责、依赖方向和任务生命周期 |
| [部署手册](docs/deployment.md) | 域名、服务进程、本机执行器和升级流程 |
| [路线图](docs/roadmap.md) | 已实现范围与后续规划 |

## 参与贡献

欢迎提交 Issue 和 Pull Request。新增模型协议、检测引擎或项目适配器时，请同时补充对应的接口契约、错误语义、测试和文档；不要把规划中的能力写成已实现功能。
