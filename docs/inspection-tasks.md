# 巡检任务与 New API 项目接入

## 使用流程

1. 登录后进入顶部「巡检任务」，通过左侧顶部「＋ 添加项目」添加项目连接。当前类型为 New API；填写管理站点根地址（不要填模型 `/v1` 地址）、管理员账号/邮箱（通过一次密码登录解析 ID）或高级 User ID，以及个人设置中的 Access Token。普通 `sk-` 模型令牌不能替代管理令牌。
2. 在左侧选择项目后，右侧卡片直接展示渠道列表；点击列表顶部「立即同步」，默认同步渠道元数据并导入全部启用、支持直连渠道的 Key；导入 Key 时必须填写该管理员当前的 2FA 验证码。也可以取消导入选项只同步元数据。只支持 Passkey 的账号无法由当前服务自动完成验证。New API 的渠道 Key 接口有独立限流，渠道较多时可能需要等待限流窗口后重试。本服务分页读取渠道列表，从渠道 `group` 字段聚合路由分组，并同步 New API 渠道 `tag` 标签；不使用账户分组接口冒充路由分组。
3. 项目卡片主体始终以渠道为行，分组作为渠道属性；「连接、设置、立即同步、删除、立即巡检」集中在列表顶部。可按所属分组或渠道标签筛选后分页，切换筛选条件会回到第一页；支持每页 10、20、50 条。勾选支持且启用的渠道，点击“导入选中渠道的密钥”，必须提交该 Access Token 所属管理员当前的 6 位 2FA 验证码。
4. 在「设置」中选择巡检范围、模型以及一个或多个巡检引擎。引擎目录与顶部「巡检引擎」页面一致，当前为 Fingerpoint 和 Terminal Bench。选择 Terminal Bench 后可配置 `daily`（6 题）或 `full`（89 题）与题目并发数（1–4）；参数保存在计划的 `evaluator_options` 中。模型 ID 留空使用各渠道配置，指定时取交集。
5. 保存设置后可点击项目顶部「立即巡检」，也可以在项目页顶部选择多个项目，点击「批量立即巡检」。批量触发逐项目报告成功或失败，已成功创建的批次不会因为其他项目失败而撤销。
6. 打开定时开关并保存，即授权本服务按分钟间隔向上游模型发出真实检测请求。首次执行在一个间隔之后；修改计划重新计算下次时间。
7. 在顶部「巡检日志」按「项目巡检」类型筛选各项目历史；打开批次详情并展开渠道行查看每个渠道/引擎的状态、失败原因和模型结果。日志列表支持按模型、项目、引擎和来源组合筛选。

项目连接、渠道元数据和已导入的 Key 只保存在服务端。它们与普通「首页」页面的浏览器 localStorage 服务配置相互独立。前端不会收到项目 Access Token 或渠道 Key。

## 正式接口与权限

New API 连接器位于 `internal/projects/newapi`，调用：

| 接口 | 用途 |
| --- | --- |
| `GET /api/channel/?p=N&page_size=100&id_sort=true` | 获取渠道元数据，按 `data.items` / `data.total` 分页 |
| `POST /api/verify` | 导入 Key 时按目标要求提交 `{method:"2fa",code:"..."}` 完成安全验证 |
| `POST /api/channel/{id}/key` | 获取单个渠道的 Key |

请求发送 `Authorization: Bearer <管理员 Access Token>` 和 `New-Api-User: <User ID>`。安全验证和读取 Key 使用同一次操作内的 cookie jar；验证码和验证 Cookie 不持久化。连接器禁止携带管理凭据跟随重定向。

标准 New API 的渠道 Key 接口要求 Root 权限和有效安全验证，并且挂在 CriticalRateLimit 下（默认配置通常是客户端 IP 20 次/20 分钟，实际以目标实例配置为准）。本项目遵守接口返回：403、验证过期、只允许 Passkey 等情况会显示失败原因，不绕过验证、不探测数据库、不修改 New API 配置。只支持 Passkey 的环境需要管理员提供正式的机器接入方式，当前连接器不自动操作浏览器。

### 为什么同步后看不到密钥

- “同步元数据”只获取分组、渠道、模型等信息，不读取 Key。“尚未导入密钥”表示本服务没有该渠道的凭据；即使导入成功，浏览器也只展示“已导入密钥”，不显示明文。
- 能读取渠道列表不代表能读取 Key：Key 接口还检查 Root 权限。普通管理员可能可以同步，但导入被拒绝。
- 标准 New API 要求本次导入的安全验证；在另一个浏览器完成的验证不属于本服务的 cookie jar。2FA 未启用、验证码错误、验证过期会分别显示可识别的固定原因；只启用 Passkey 的账号不适用当前验证码流程。
- 渠道 Key 接口的限流会在达到窗口后返回 429。本服务识别非 JSON 的 429 响应，停止继续请求并把限流原因记录到剩余渠道，避免把所有渠道误报成“非预期 JSON”。等待目标实例的限流窗口结束后，只重试失败渠道。
- 导入失败直接显示在导入弹窗内。部分成功时成功项会保存，失败项保留在渠道表“密钥状态”列；重试只包含失败渠道。验证码在请求结束后清空。
- 错误码和已知固定错误文本会转为本服务的诊断说明，未知响应仍给出概括提示；不会把任意上游错误体或可能夹带的凭据返回浏览器。

外部分支需保持上述响应契约；列表缺少 `items/total`、分页重复或提前结束时会报错，不能把残缺列表当作同步成功。

## 上游直连范围

**按分组选取其中的渠道，随后本服务直连渠道上游。** 这验证的是渠道的上游模型，不是 New API 网关的分组路由、计费或故障切换行为。分组本身没有一套独立的上游 URL 与 Key。

当前支持：

- New API 渠道类型 `1`：OpenAI Chat Completions。
- New API 渠道类型 `14`：Anthropic Messages。
- Base URL 为空时使用这两种类型的官方默认地址；根地址或路径后统一追加 `/v1`，已以 `/v1` 结尾的不重复追加。
- 应用渠道 `model_mapping`，向上游请求映射后的模型 ID。
- 多 Key 渠道在导入时选择第一个启用的普通 Key，不轮询全部 Key。扫描不修改上游 Key 状态。
- `openai_organization` 不再作为渠道禁用条件。OpenAI 协议请求携带 `OpenAI-Organization`；Anthropic Messages 使用自己的认证头，不附加 OpenAI 组织头。Fingerpoint 的 OpenAI 请求通过调用期内的本机转发补上该请求头，保留 SDK 的请求体、流式采样和评分；转发在任务调用结束后关闭，不新增持久服务。


其他渠道类型、OAuth/JSON 凭据、自定义请求头/参数覆盖暂不直连，渠道表显示原因。停用渠道不进入批次；选中但缺少密钥或不支持的渠道会保留明确的错误记录。

定时批次使用**最近成功同步的渠道与 Key 快照**。新建、停用、删除渠道、修改模型/映射或轮换 Key 后，请重新同步并按需导入密钥。同步发现同一渠道的 URL 或协议改变时会清除旧 Key，避免把旧密钥发送到新目标；修改项目地址、用户或管理令牌会清空渠道快照并关闭计划。

## 每个渠道的测试协议

渠道表中的“测试协议”可选择“跟随渠道”、OpenAI Chat Completions 或 Anthropic Messages。修改后自动保存到本服务，仅用于后续的手动/定时检测，不修改 New API 的渠道类型或配置。

`protocol` 保留同步得到的协议，`protocol_override` 保存用户选择；可选值为 `chat_completions`、`responses`、`messages`。无法识别协议的新导入渠道默认 `chat_completions`（对话补全）；已识别的 New API 渠道仍跟随其来源协议。空覆盖值表示跟随渠道。既有渠道保留已保存的选择，不会被重新同步覆盖。重新同步和后端重启会保留已保存的覆盖值。批次创建时记录实际使用的 `protocol`，Smoke 与 Fingerpoint 均使用此协议，批次详情可以查看。

已有持久化文件仍通过 `OpenStore` 的 version=1 JSON 入口读取；新增字段是可选字段，旧数据缺省为没有 Organization 信息和没有协议覆盖，既有计划、密钥及批次不被重建。升级后需重新同步渠道元数据，才能补齐 Organization 信息并清除旧版本缓存的不支持提示。

## 调度与状态

- 每个项目保存一个计划，间隔 `1–10080` 分钟；调度器每 5 秒检查到期项。
- 一个项目内部按「渠道 × 引擎」串行执行，并等待当前扫描真正终止后再执行下一项。不同项目可同时运行。
- 同一项目的同步、密钥导入和巡检互斥。运行中更新/删除项目或重复手动触发返回 409。调度器不会重叠运行该项目。
- 批次结束后按结束时间加间隔计算下次时间。手动运行也重置该项目的下次执行时间。
- `completed` 表示检测执行完成，可以包含判定未通过；调用/配置错误使用 `completed_with_errors`，停止或重启中断使用 `interrupted`。
- 服务退出取消后台工作。重启将未完成批次标为中断；不会自动重放已消费额度的任务，也不补跑停机期间错过的间隔。已启用计划从重启后的下一个间隔执行。
- 前端每 5 秒刷新批次。每项模型扫描结束后保存其完整结果快照；进行中只显示该项执行状态。
- 每个项目保留最近 50 个批次，正在运行批次不被清理。删除连接保留已有的无凭据批次快照供审阅。

## 存储与初始化

环境变量 `DATA_DIR` 默认为项目根目录下的 `data/`。新目录首次启动创建：

- `inspection.key`：32 字节随机 AES 密钥，权限 `0600`。
- `inspections.enc`：AES-256-GCM 加密的配置、渠道凭据和批次历史，写入采用同目录临时文件加原子替换。

云端 SQLite 与 `cloud.key` 使用 `0700/0600` 权限，按账号保存项目与批次。丢失 `cloud.key` 时服务启动失败，不会生成替代密钥。旧版加密巡检文件保留在原位置，不执行迁移。

本地模式的项目、配置和结果由浏览器 IndexedDB 保存；本机执行器退出后未完成任务标记中断，不会自动转移到云端。持有数据文件和密钥文件的本机用户仍可解密，因此不是对主机管理员的访问隔离。

云端使用 `cloud.sqlite`，由 `internal/cloud/schema.sql` 初始化；账号、会话、项目、模型 API、扫描和批次均按账号隔离。旧加密巡检文件不会迁入 SQLite，保留在原位置。`cloud.key` 丢失时云端服务拒绝启动，不会生成替代密钥。

本地模式使用浏览器 IndexedDB 保存项目、模型 API 和批次；执行由本机执行器完成，不支持云端定时计划。

如果后台保存失败，服务停止调度并对任务接口返回错误，不能继续显示持久化成功。普通临时巡检结果仍使用原有内存 Store；由项目计划产生的结果会另行存入持久化批次。

## 本服务 HTTP API

云端接口要求当前账号的 Bearer 会话；本地执行器接口要求本机配对会话。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/v1/inspection/projects` | 项目卡片与脱敏渠道/计划 |
| `POST /api/v1/inspection/projects` | 保存新连接 |
| `PUT /api/v1/inspection/projects/{id}` | 编辑连接，Access Token 留空保留原值 |
| `DELETE /api/v1/inspection/projects/{id}` | 删除连接、密钥、计划 |
| `POST /api/v1/inspection/projects/{id}/sync` | 同步渠道元数据 |
| `POST /api/v1/inspection/projects/{id}/keys` | `{channel_ids:[],two_factor_code:""}` 导入凭据 |
| `PUT /api/v1/inspection/projects/{id}/plan` | 保存范围、模型、引擎、间隔、开关 |
| `PUT /api/v1/inspection/projects/{id}/channels/{channelID}/protocol` | `{protocol:"chat_completions"}`、`responses` 或 `messages`；空字符串恢复跟随渠道，返回更新后的项目 |
| `POST /api/v1/inspection/projects/{id}/run` | 手动触发并返回 202 批次 |
| `POST /api/v1/inspection/batch-run` | `{project_ids:[]}` 批量触发并返回逐项目结果 |
| `GET /api/v1/inspection/runs?project_id=...` | 批次与保存的扫描结果，省略参数返回全部 |

新增项目类型实现 `pkg/project.Adapter`，在服务入口显式注册。当前 UI 只提供已经实现的 New API 类型，不为未来项目伪造可用选项。

## 账号/邮箱与一键同步

账号/邮箱方式先调用 `POST /api/user/login`，必要时调用 `/api/user/login/2fa`，取得真实 ID 后用独立的 Access Token 请求 `/api/user/self` 核对身份。密码和登录 OTP 不保存，长期同步仍使用管理 Access Token。目标若禁止密码登录、要求 Turnstile 或仅支持 Passkey，应使用高级 User ID + Token 或其正式机器接入机制，不能绕过认证。

`POST /inspection/projects/{id}/sync` 支持 `{import_keys:true,two_factor_code:"..."}`，页面默认勾选导入 Key 并提交 `import_keys=true`，此时必须提供 6 位 2FA 验证码。直接调用 API 时，省略或关闭 `import_keys` 仍只同步元数据。安全验证或限流失败时保留成功读取的元数据，并逐渠道记录失败；不能把缺失/过期密钥当作同步成功。原有单独导入接口仍可用于指定渠道。OpenAI 类型 1 本来就通过 `/v1/chat/completions` 执行，页面现在明确标注 Chat Completions。

## 统一引擎与旧计划

项目通过 `/api/v1/evaluators` 获取引擎数组；`smoke` 已退出生产注册。仍包含 smoke 或其他已停用引擎的旧计划会停止定时调度，保留原选择供用户修改；不会自动替换成指纹检测或 Terminal Bench。取消已停用项、选择新引擎并保存后，才能继续执行。

Terminal Bench 适配器位于 `internal/evaluators/terminalbench`，使用渠道的 Base URL、Key、协议和模型，按模型依次调用现有 Harbor Service。默认日常题集、题目并发 1，使用固定的 Terminus-2 agent；题集和并发数可以在设置中调整。与独立页面共用单任务运行限制，环境未就绪或已有任务时返回明确错误，不会静默切换引擎。当前适配器不支持带 OpenAI Organization 的渠道，会明确报错而不丢弃该配置。

批次结果保留 Terminal Bench 任务 ID、题集和逐题通过、未通过、运行错误结果；独立页面仍可查看进度或取消运行。参数与加密项目快照一起保存，新库及旧库使用同一 JSON 结构，缺失 `evaluator_options` 时使用所选引擎的默认参数。
