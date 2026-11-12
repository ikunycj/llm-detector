# Fingerpoint 模型指纹检测

## 接入方式

项目锁定使用 `github.com/Ikaleio/lm-detector/sdk/go`，适配器位于 `internal/evaluators/fingerprint`，注册 ID 为 `fingerprint`。该 evaluator 自带协议适配；普通模型服务配置也支持 Chat Completions 和 Messages，可使用 SDK 支持的 Responses、Chat Completions 或 Anthropic Messages 请求，不要求 Provider Registry 发送请求。指纹任务需明确指定单一模型 ID，不能选择全部模型。

网页通过顶部「巡检引擎」进入，再在左侧菜单选择「指纹检测」。左侧菜单可切换到「Terminal Bench」，窄屏使用引擎选择器切换。检测界面由本项目提供，采用顶部可折叠 API 配置条和三张并排样本卡片。支持选择已保存的模型 API（含浏览器本地）或新增配置；执行位置仍由统一的位置选择器决定。

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

结果保留决策、模型/家族候选、排序分数、参考库内概率及其状态、有效整数数量、样本状态、首响应时间、参考库构建时间和证据。样本额外保存实际提示词与经过 Key 脱敏的回复文本 `output`，每条最多保留 16,384 个字符，超长时标记 `output_truncated`；这些字段不写入运行日志。新界面的请求可带 `elapsed_ms`。旧历史没有回复字段时明确显示未保存，不用新提示词伪造历史记录。

**封闭参考集限制**：库外模型也会被映射到最相似的已知候选。概率只在参考库内比较，不是身份认证、API 渠道真实性证明或通用智力分数。可信度判断应固定参数、重复多轮并结合其他证据。

## 三样本取样界面

- 进入页面就生成一组 3 条挑战，可展开与复制每条提示词。
- 「换一组提示词」仅在本地生成新挑战并清空当前显示，不发出模型请求；历史结果仍保留。
- 「开始取样」提交页面正在显示的挑战。浏览器直连按官方 transport 边接收边更新样本卡片；云端及 Worker 在任务结束后返回三条回复。
- 每张卡片显示请求/完成/出错状态、回复、有效数字数量与可用的耗时指标。失败及部分返回的样本不会伪装成成功。
- 当前轮次的候选排名保留在样本卡片下方；历史指纹任务统一迁入顶部「巡检日志」，按指纹引擎筛选后可查看当时的提示词、输出与排名。

`evaluator_options.challenges` 是可选数组，每项包含 `id`、`prompt`、`expected_count`，数量必须与 `count` 一致（1–3）。ID 必须唯一且非空（最多 128 字节），提示词非空且最多 16,000 字节，`expected_count` 为生成器使用的 292–332。省略时仍由 SDK 自行生成。传入时，Go 端使用 SDK `RequestSample` 请求这些原样提示词并用 `Analyze` 评分；严格模式仍要求三条成功样本。浏览器侧与 Go 侧都保留对应的样本证据。
