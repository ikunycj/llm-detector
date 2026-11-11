# LLM Detector

Go + React 的模型智力检测 / 巡检项目。用户通过部署访问密钥登录，输入厂商（协议适配器）、API URL 和 API Key，对全部或指定模型执行检测并查看结果。

项目已具备可运行的基础闭环。内置 **OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 协议**、**smoke 基础检查**，并接入官方 **Fingerpoint Detector Go SDK** 用于模型指纹候选识别。Smoke 检查用于接入和回归；Fingerpoint 使用随机整数输出进行参考库候选排序；两者都不是通用智力评分。

## 项目巡检任务

新增「巡检任务」页面：保存 New API 管理连接，服务端同步分组/渠道，经正式安全验证导入 Key 后，按分组或渠道批量巡检。支持多引擎、手动批量触发和服务端间隔调度；浏览器关闭不影响运行。

连接、Key 和批次历史存入 `DATA_DIR`（默认 `data/`）中的加密文件，密钥不回显。当前直连支持 OpenAI(1)、Anthropic(14) 渠道；分组用于选择渠道，结果不代表 New API 网关路由检查。计划需显式启用，使用最近同步的渠道/密钥快照。

操作与权限要求、持久化及重启行为见 [项目巡检任务](docs/inspection-tasks.md)。

## Terminal Bench

顶部「巡检引擎」页面通过左侧菜单切换「指纹检测」和「Terminal Bench」。其中 Terminal Bench 提供完整 89 题和指定的日常 6 题，固定 `terminal-bench@2.0` 与源码 commit，使用 Harbor 0.25.0 / Terminus-2 / Docker。先运行 `make terminal-bench-install` 并在页面检查环境，再填写模型连接并主动启动。支持进度、取消和逐题 verifier 结果；未安装可选依赖不影响主服务启动。详见 [Terminal Bench](docs/terminal-bench.md)。

## 设计重点

- **模型协议和检测引擎分别扩展**：`pkg/provider` 负责发现/调用模型；`pkg/evaluator` 负责题库、调用编排和判定。评测 SDK 可以自行执行多轮调用，不受单题字符串评分接口限制。
- **检测引擎可选接入**：核心通过 `pkg/evaluator` 接口隔离评测依赖。Fingerpoint SDK 由独立 evaluator 实现，其他检测 SDK 不进入核心调用方。
- **指定模型可以直接运行**：手动输入模型 ID，不强制依赖 `/models`。`scope=all` 才会在任务执行时重新发现全部模型。
- **结果区分错误类型**：检查状态为 `passed`、`failed`、`error`。模型回答未通过与接口调用失败分开统计。
- **模型指纹检测**：独立“指纹检测”页面支持 OpenAI Responses、Chat Completions 与 Anthropic Messages 协议，展示挑战样本、候选排名与参考库概率。
- **简单共享密钥登录**：部署密钥来自 `APP_LOGIN_KEY`；服务发放有 TTL、可注销的随机 Bearer 会话。浏览器只在内存保留令牌，刷新需要重新登录。

## 本地启动

需要 Go **1.26+**、Node.js **22.12+** 和 npm。依赖版本已锁定在 `web/package-lock.json`。

首次启动在项目根目录安装前端依赖并生成本地开发环境文件：

```bash
make install
make init-env
```

`make init-env` 会在缺少 `.env` 时从模板创建文件，并生成随机开发登录密钥；文件权限设为当前用户可读写，`.env` 已加入 Git 忽略规则。密钥不会输出到终端。若已有 `.env` 和自定义密钥，该目标会保留它们。

分别在两个终端启动后端与前端：

```bash
make backend
```

```bash
make frontend
```

Go 后端每次启动都会直接读取项目根目录 `.env` 中的 `APP_LOGIN_KEY`。shell 中同名环境变量不会覆盖登录密钥，因此 `go run ./cmd/server` 和构建后的 `./bin/server` 也必须从项目根目录启动并使用同一份 `.env`。`make backend` 与 `make frontend` 都会先确保开发 `.env` 存在。

打开 `http://127.0.0.1:9000`。Vite 将 `/api` 和 `/healthz` 代理到 `127.0.0.1:9001`，前端无需配置 API 地址或 CORS。修改后端端口时，同步修改 `web/vite.config.ts` 的代理目标。

选择顶部“指纹检测”可运行官方 Fingerpoint SDK。首次执行时会下载约 3.6 MB 的参考数据并缓存；首次加载需要联网。可用 `.env` 中的 `FINGERPRINT_DATA_SOURCE` 指定参考数据源，`FINGERPRINT_CACHE_PATH` 指定缓存文件。默认使用 SDK 官方数据源与系统缓存位置。

使用流程：

1. 输入 `APP_LOGIN_KEY` 登录。
2. 输入完整 API 根地址（如 `https://api.example.com/v1`）和模型服务 API Key。
3. 可选“发现可用模型”；也可直接在“指定模型”中输入 ID。
4. 选择检测引擎并开始巡检。全部模型模式会向列表中的每个模型发起实际请求并消耗额度。
5. 查看逐模型进度，展开检查项查看输出或错误。也可选择本次服务运行期间的历史任务。

模型服务支持“保存到本机”：服务名称、协议适配器、Base URL 和 API Key 会写入当前浏览器的 `localStorage`，下次打开页面可直接选择。保存项只存在当前浏览器，不会写入后端任务存储；由于 API Key 是本地明文存储，只建议在个人受信任设备上使用。

巡检引擎支持一次选择多个引擎。Terminal Bench 可在设置中选择日常 6 题或完整 89 题、题目并发数；每个渠道的模型依次使用已导入的 Key 创建 Harbor 任务。提交后每个引擎创建独立任务，结果页把每个模型/引擎任务展平为列表，可按模型名或 ID、模型服务、巡检引擎、任务状态筛选。Fingerpoint 在“全部模型”模式下会先发现模型，再为每个模型创建指定模型指纹任务。

## 构建与验证

```bash
make test          # Go 行为测试（只访问本地 httptest 服务）+ TypeScript 检查
make build         # bin/server + web/dist
go test -race ./... # 需要检查并发存储时运行
```

构建后可以由 Go 同源托管前端：

```bash
# 从项目根目录运行；登录密钥仍由 .env 读取
WEB_DIST_DIR=web/dist ./bin/server
```

打开 `http://127.0.0.1:9001`。也可以使用反向代理托管 `web/dist` 并转发 `/api`。默认前端监听 `9000`、后端监听 `9001`，均只监听本机；部署时自行设置 `HTTP_ADDR` 并配置 HTTPS。

## 文件结构

```text
.
├── cmd/server/                  # 启动入口、依赖装配、显式插件注册、优雅退出
├── internal/
│   ├── auth/                    # 环境密钥认证、内存会话、注销
│   ├── config/                  # 环境变量与启动校验
│   ├── httpapi/                 # HTTP 路由、鉴权、输入边界
│   ├── providers/               # 模型协议注册表、内置 OpenAI 兼容实现
│   ├── evaluators/
│   │   ├── registry.go          # 检测引擎注册表
│   │   ├── smoke/               # 内置基础检测引擎
│   │   └── fingerprint/         # 官方 lmfpd Go SDK 适配
│   ├── scan/                    # 领域模型、Store 接口、异步任务编排
│   └── store/                   # 并发安全的内存 Store 实现
├── pkg/
│   ├── provider/                # 外部模型适配器契约，无 SDK 依赖
│   └── evaluator/               # 外部检测 SDK 契约，无 SDK 依赖
├── extensions/                  # 可选扩展边界与目录规划；当前没有外部 SDK
├── web/
│   └── src/
│       ├── features/auth/       # 登录界面
│       ├── features/scans/      # 连接、范围、巡检结果
│       ├── features/engines/    # 巡检引擎入口与左侧引擎切换菜单
│       ├── api.ts               # 第一方 API 客户端
│       ├── types.ts             # API 响应契约
│       └── App.tsx              # 内存登录态与页面入口
├── docs/                        # 架构、API、扩展指南与路线
├── AGENTS.md                    # 项目协作与编程规则
├── PRODUCT.md / DESIGN.md       # 产品范围、当前界面约定
├── .env.example                 # 不含真实密钥的配置模板
└── Makefile
```

## 当前边界

- **存储边界**：登录会话与普通临时巡检仍在内存中；项目连接、计划、渠道凭据与批次结果加密持久化。所有持有登录密钥的人共享同一工作台。
- **Fingerpoint 结果边界**：这是封闭参考库内的候选排序；库外模型也会得到最相似候选，概率只在库内比较，不是身份认证或服务可信度证明。首次检测需要联网下载官方参考数据。
- **调度边界**：「巡检任务」支持按项目间隔调度与手动触发，项目内串行且不重叠运行；暂未提供全局并发上限、取消接口、cron 表达式或成本预算。
- **凭据**：输入保留在当前页面内存，后端在任务执行上下文中使用 API Key，不写入结果模型/磁盘/日志；调用结束后不再由任务引用，不承诺内存安全擦除。
- **错误与证据**：不返回上游错误响应体或带地址的传输错误；保存输出摘要前替换本次提交的 API Key 并限制为 1000 字符。其他潜在敏感输出尚无通用脱敏能力。
- **协议覆盖**：支持 `/models`、文本 `/chat/completions`、`/responses` 和 Anthropic `/messages`，Base URL 不自动补 `/v1`。全部模型列表可能包含 embedding、视觉等不兼容模型，这些会报告调用错误，不静默跳过。
- **弱依赖并非热加载**：当前通过接口和编译时注册扩展。Python/Node SDK 的独立 worker、进程协议和自动探测均尚未实现。
- **部署定位**：当前面向受信任的本地/内部使用者，可连接 localhost 和内网网关；未实现出站地址白名单，不宜直接开放给不可信用户。

详细设计从 [docs/README.md](docs/README.md) 开始。
