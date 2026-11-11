# Fingerpoint 模型指纹检测

## 接入方式

项目锁定使用 `github.com/Ikaleio/lm-detector/sdk/go`，适配器位于 `internal/evaluators/fingerprint`，注册 ID 为 `fingerprint`。该 evaluator 自带协议适配；普通模型服务配置也支持 Chat Completions 和 Messages，可使用 SDK 支持的 Responses、Chat Completions 或 Anthropic Messages 请求，不要求 Provider Registry 发送请求。指纹任务需明确指定单一模型 ID，不能选择全部模型。

网页通过顶部「巡检引擎」进入，再在左侧菜单选择「指纹检测」。左侧菜单可切换到「Terminal Bench」，窄屏使用引擎选择器切换。检测界面由本项目提供。

## 请求配置

```json
{
  "base_url": "https://api.example.com/v1",
  "api_key": "provider-api-key",
  "scope": "selected",
  "models": ["model-a"],
  "evaluator": "fingerprint",
  "evaluator_options": {
    "api": "chat_completions",
    "count": 3,
    "strict": true,
    "timeout_seconds": 120
  }
}
```

API 类型为 `responses`、`chat_completions` 或 `messages`。样本数范围 1–3；严格模式要求样本数为 3；请求超时范围 1–3600 秒，实际值还受 `.env` 中 `FINGERPRINT_REQUEST_TIMEOUT` 限制。默认生成 3 条挑战，每条要求模型输出约 292–332 个整数。严格模式要求全部样本有效；非严格模式可用不足三条有效样本形成部分排名。

## 参考数据

SDK 不把模型参数打包在 Go module 中。首次运行指纹任务时下载约 3.6 MB 压缩参考数据，失败会使该任务失败，不阻塞服务启动。成功后 SDK 将数据缓存到系统用户缓存路径，并按 SDK 自身策略检查更新。

- `FINGERPRINT_DATA_SOURCE`：覆盖 SDK 数据源。支持 SDK 定义的 HTTP(S) base URL 或本地数据目录；设置后是单一数据源，不会再追加 SDK 默认后备源。
- `FINGERPRINT_CACHE_PATH`：覆盖 SDK 缓存文件路径。
- `FINGERPRINT_REQUEST_TIMEOUT`：每次模型样本请求的服务端超时上限，默认 `120s`，Go duration 格式。

留空时使用 SDK 官方默认数据源与系统缓存目录。

## 结果语义

- `scored`：完整三样本排名。
- `partial`：非严格模式下以不足三条有效样本做出的部分排名。
- `unscorable`：样本不足以形成排名。
- `not_model`：SDK 认为样本数列特征不符合模型回答特征。

结果保留决策、模型/家族候选、排序分数、参考库内概率及其状态、有效整数数量、样本状态、首响应时间、参考库构建时间和证据。不会保存每条挑战的完整模型回答。

**封闭参考集限制**：库外模型也会被映射到最相似的已知候选。概率只在参考库内比较，不是身份认证、API 渠道真实性证明或通用智力分数。可信度判断应固定参数、重复多轮并结合其他证据。
