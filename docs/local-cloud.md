# 本地与云端模式

## 工作区和登录

页面顶部的「本地 / 云端」是两个工作区，首次打开默认进入本地，不会被登录拦截。

本地模式可以直接打开首页、编辑模型 API 和查看浏览器里的历史。点击「云端」时才要求登录。登录态保存在当前浏览器，使用服务端返回的过期时间；默认 `.env` 的 `SESSION_TTL=24h`，过期后需要重新登录。刷新页面仍默认回到本地，但有效的云端会话会保留，下一次切换云端时可直接校验并恢复。

登录后的作用是把当前账号的个人配置和历史拉到浏览器视图。浏览器不会用云端数据覆盖本地数据；模型 API、扫描结果和 Terminal Bench 记录都带有本地或云端来源。云端模型 API 的真实 Key 只保存在服务器，浏览器只收到 `has_key` 标记。

## 执行位置

每个巡检引擎都单独选择「本地执行」或「云端执行」，顶部工作区不再决定执行位置。

- Fingerpoint 本地执行：浏览器直接调用 `lmfpd-sdk` 的 shared detector 和模型 API，不需要本机执行器。供应商必须允许浏览器跨域请求；跨域被拒绝时页面会显示直连错误。
- Fingerpoint 云端执行：服务器使用 Go SDK 执行，结果保存到云端账号或当前任务结果中。
- Terminal Bench 本地执行：本机执行器调用 Harbor，需要本机 Docker、Git、Python 3.12 和 Harbor。
- Terminal Bench 云端执行：服务器调用 Harbor，结构化结果保存到云端账号目录和 SQLite。

云端保存的模型 Key 不会下发到浏览器，因此使用云端配置时只能选择云端执行。使用本地配置选择云端执行时，页面会明确提示 API Key 将随本次检测请求发送到云端；只有用户主动选择云端执行才会发生这次传输。

## 本地

本地模型 API、New API 项目快照、扫描结果和本地 Terminal Bench 记录保存在浏览器 IndexedDB 或本地存储中。本地 Fingerpoint 不依赖 Python；本地 Terminal Bench 才需要执行器。

执行器监听 `127.0.0.1:9002`，通过页面来源限制和短期会话保护本地请求。默认允许 `http://127.0.0.1:9000` 和 `http://localhost:9000`。执行器重启后，页面要求重新连接；浏览器数据不会因此删除。

本地执行器连接建立后，项目巡检和 Terminal Bench 的本地任务由执行器管理。浏览器关闭或执行器退出时，未完成任务会标记为中断，不能自动转移到云端继续执行。临时任务目录在会话结束后清理。

## 云端

云端账号和会话存储在 `DATA_DIR/cloud.sqlite`，密码使用 Argon2id 哈希，模型 API Key 使用 `cloud.key` 加密保存。业务数据按 `user_id` 隔离，账号不能读取其他账号的数据。

首次新建 SQLite 时，`CLOUD_ADMIN_USERNAME` 和 `CLOUD_ADMIN_PASSWORD` 用于创建初始账号。后续账号使用：

```bash
printf '%s\n' 'your-password' | go run ./cmd/user -username another-user
```

不执行旧加密巡检文件到 SQLite 的迁移；`data/` 中原有文件保持原样。页面读取旧格式扫描记录时会直接删除无法渲染的记录，避免旧数据让 React 页面崩溃。

## 本机执行器打包

```bash
make local-runner-build
```

该命令生成 macOS、Linux、Windows 的 ARM64 和 x64 zip，并生成 SHA-256 文件。执行器是未签名开发构建；实际启动还需要在对应系统确认 Docker、Git、浏览器本地网络访问和 Harbor 环境。

启动执行器：

```bash
./llm-detector-local --origin 'http://127.0.0.1:9000,http://localhost:9000'
```

也可以通过环境变量指定来源：

```bash
LLM_DETECTOR_LOCAL_ORIGINS=https://detector.example.com ./llm-detector-local
```
