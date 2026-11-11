# HTTP API v1

前端和 API 使用同源路径。云端业务接口需要账号会话；公开目录接口无需登录。本地模式的业务请求发送到本机执行器，而不是云端服务。错误响应统一为 `{"error":"message"}`，API 响应带 `Cache-Control: no-store`。

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /healthz` | 存活检查 `{"status":"ok"}` | 200 |
| `POST /api/v1/auth/login` | 云端账号密码登录 | 200 |
| `POST /api/v1/auth/logout` | 撤销当前会话，无响应体 | 204 |
| `GET /api/v1/providers` | 当前注册的模型协议适配器 | 200 |
| `GET /api/v1/evaluators` | 当前注册的巡检引擎 | 200 |
| `POST /api/v1/models/discover` | 模型发现 | 200 |
| `POST /api/v1/scans` | 创建异步巡检 | 202 |
| `GET /api/v1/scans` | 内存任务完整快照，按创建时间倒序 | 200 |
| `GET /api/v1/scans/{id}` | 单任务快照 | 200 |

`GET /api/v1/evaluators` 返回统一的巡检引擎目录，当前生产注册为 `fingerprint` 和 `terminal-bench`。每项包含 `id`、`name`、`description`；可选的 `default` 表示新配置默认选中，`requires_explicit_models` 表示需明确模型 ID。`options` 数组提供参数控件的 `key`、`label`、`kind`、`default` 与 `choices` 或 `min/max`。顶部引擎菜单与项目设置均读取这份目录。

## 登录

```json
{"username":"admin","password":"your-password"}
```

响应示例（时间与 token 为示例）：

```json
{"token":"session-token","expires_at":"2026-11-10T12:00:00Z"}
```

账号或密码错误为 401；会话过期、重启或注销后也返回 401。不存在的任务返回 404。登录 token 是唯一需要返回客户端的认证凭据，部署密钥与模型 API Key 不回显。

## 模型发现

```json
{
  "vendor":"openai-compatible",
  "base_url":"https://api.example.com/v1",
  "api_key":"provider-api-key"
}
```

响应：

```json
{"models":[{"id":"model-a","name":"model-a"}]}
```

URL 必须是完整 HTTP(S) API 根地址，不能有用户名/密码、查询参数或 fragment。不自动补 `/v1`。当前 Provider 将 `/models` 拼在根地址后。模型 ID 去重并排序；合法的空数组会正常返回，结构不兼容返回 502。

## 创建扫描

指定模型，不调用 `/models`：

```json
{
  "vendor":"openai-compatible",
  "base_url":"https://api.example.com/v1",
  "api_key":"provider-api-key",
  "scope":"selected",
  "models":["model-a","model-b"],
  "evaluator":"fingerprint"
}
```

扫描全部模型时先调用 `/models/discover`，再将返回的 ID 列表作为 `scope=selected` 的 `models`，分别提交所选引擎。当前注册的两个引擎都要求明确模型 ID。

Terminal Bench 示例：

```json
{
  "base_url":"https://api.example.com/v1",
  "api_key":"provider-api-key",
  "protocol":"chat_completions",
  "scope":"selected",
  "models":["model-a"],
  "evaluator":"terminal-bench",
  "evaluator_options":{"suite":"daily","concurrency":1}
}
```

`scope`、`evaluator`、`base_url` 和 `api_key` 必填，`service_name`、`protocol` 可选（`protocol` 默认为 `chat_completions`，也可设为 `responses` 或 `messages`），用于结果列表筛选；为空时后端使用 Base URL。普通 evaluator 还要求已注册 `vendor`；`fingerprint` 是 provider-independent evaluator，可以省略 `vendor`，但必须选中一个模型，不能使用 `scope=all`。`selected` 至少一个非空 ID；`all` 不允许非空模型列表。重复模型 ID 去重。`evaluator_options` 是可选 JSON 对象，Fingerpoint 支持 `api`、`count`、`strict`、`timeout_seconds`。未知 provider/evaluator、无效输入或多个 JSON 值返回 400；没有“选中为空自动变成全部”的隐式行为。请求体上限 1 MiB，未知 JSON 字段拒绝。

创建后立即返回任务（`models` 初始为空）：

```json
{
  "id":"scan-example",
  "status":"pending",
  "vendor":"openai-compatible",
  "evaluator":{"id":"fingerprint","name":"Fingerpoint 指纹检测","description":"模型指纹候选识别。","requires_explicit_models":true},
  "scope":"selected",
  "models":[],
  "created_at":"2026-11-10T04:00:00Z"
}
```

## 任务结果

`GET /scans` 返回 `{"scans":[...]}`，无分页；`GET /scans/{id}` 直接返回一个 Scan。时间使用 RFC 3339，运行时有 `started_at`，终止后有 `completed_at`。

| 任务状态 | 含义 |
| --- | --- |
| `pending` | 已创建，尚未开始 |
| `running` | 发现模型或执行引擎 |
| `completed` | 全部检测执行完成，可能有未通过项 |
| `completed_with_errors` | 执行完成，至少一个模型或检查存在调用/引擎错误 |
| `failed` | 任务级失败，例如发现失败、空模型列表、服务取消 |

模型结果示例：

```json
{
  "model":{"id":"model-a","name":"model-a"},
  "status":"completed",
  "report":{
    "checks":[
      {"id":"availability","name":"可用性","status":"passed","latency_ms":124,"output":"Hello"},
      {"id":"instruction-following","name":"精确指令跟随","status":"failed","latency_ms":140,"output":"The answer is 4."},
      {"id":"structured-output","name":"JSON 输出","status":"passed","latency_ms":132,"output":"{\"status\":\"ok\"}"}
    ]
  }
}
```

模型状态：`pending`、`running`、`completed`、`error`。检查状态：`passed`（判定通过）、`failed`（返回内容未通过）、`error`（接口/执行错误）。调用错误示例：`{"id":"availability","name":"可用性","status":"error","latency_ms":0,"error":"provider returned HTTP 429"}`。检查结果在每个模型完成时一起更新；未提供逐 token 进度。

当前没有总智力分数、成本统计、取消或重试 API。界面按检查状态分别计数。

## 项目连接、批次与定时计划

独立的 `/api/v1/inspection/*` 接口见 [巡检任务](inspection-tasks.md)。这些接口复用登录鉴权，连接/密钥保存在服务器加密文件中；普通 `/scans` 接口继续保持原有语义。

## Terminal Bench

`terminal-bench` evaluator 将 `/scans` 和项目巡检任务接到同一个 Harbor Service；也保留 `/api/v1/terminal-bench/*` 接口用于独立页面的进度、取消和历史查看。运行说明见 [Terminal Bench](terminal-bench.md)。
