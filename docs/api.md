# HTTP API v1

前端和 API 使用同源路径。除 `/healthz` 和登录外，所有业务接口都需要 `Authorization: Bearer <session-token>`。错误响应统一为 `{"error":"message"}`，API 响应带 `Cache-Control: no-store`。

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /healthz` | 存活检查 `{"status":"ok"}` | 200 |
| `POST /api/v1/auth/login` | 部署密钥登录 | 200 |
| `POST /api/v1/auth/logout` | 撤销当前会话，无响应体 | 204 |
| `GET /api/v1/providers` | 当前注册的模型协议适配器 | 200 |
| `GET /api/v1/evaluators` | 当前注册的检测引擎和版本 | 200 |
| `POST /api/v1/models/discover` | 模型发现 | 200 |
| `POST /api/v1/scans` | 创建异步巡检 | 202 |
| `GET /api/v1/scans` | 内存任务完整快照，按创建时间倒序 | 200 |
| `GET /api/v1/scans/{id}` | 单任务快照 | 200 |

## 登录

```json
{"key":"your-deployment-login-key"}
```

响应示例（时间与 token 为示例）：

```json
{"token":"session-token","expires_at":"2026-11-10T12:00:00Z"}
```

密钥错误为 401；会话过期、重启或注销后也返回 401。不存在的任务返回 404。登录 token 是唯一需要返回客户端的认证凭据，部署密钥与模型 API Key 不回显。

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
  "evaluator":"smoke"
}
```

扫描全部模型：

```json
{
  "vendor":"openai-compatible",
  "base_url":"https://api.example.com/v1",
  "api_key":"provider-api-key",
  "scope":"all",
  "models":[],
  "evaluator":"smoke"
}
```

`scope` 与 `evaluator` 必填。`selected` 至少一个非空 ID；`all` 不允许非空模型列表。重复模型 ID 去重。未知 provider/evaluator、无效输入或多个 JSON 值返回 400；没有“选中为空自动变成全部”的隐式行为。请求体上限 1 MiB，未知 JSON 字段拒绝。

创建后立即返回任务（`models` 初始为空）：

```json
{
  "id":"scan-example",
  "status":"pending",
  "vendor":"openai-compatible",
  "evaluator":{"id":"smoke","name":"基础巡检","version":"1.0.0","description":"可用性、精确指令跟随与 JSON 输出；不代表通用智力基准。"},
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
