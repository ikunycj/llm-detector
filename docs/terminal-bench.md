# Terminal Bench

## 两套固定测试集

该页面对接官方 Harbor runner，使用 Terminus-2 agent 在 Docker 中执行任务，随后运行官方 verifier。它测的是「模型 + agent + 终端环境」完成真实任务的能力，不能当作普通单轮问答分数。

本次接入核对日期为 2026-11-10。上游 `harbor-framework/terminal-bench` 的 main 已不是这 6 个原题名所在的题集。因此使用 Harbor 官方注册表中仍包含这些题目的 **terminal-bench@2.0**，并固定每题源码提交：

- 完整测试集：89 题。
- 日常测试集：下述 6 题，恰好为完整题集的子集。
- 数据源码：`https://github.com/laude-institute/terminal-bench-2.git`。
- 固定 commit：`69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`。
- Harbor：`0.25.0`，运行依赖通过独立 `uv.lock` 锁定。
- Agent：`terminus-2`，使用该 Harbor 版本自带实现；一次尝试，不自动重试。当前页面和创建任务接口不提供 agent 切换；模型 ID 与 agent 是两个独立概念。

题单与来源保存在 `internal/terminalbench/catalog.json`，Go 编译时嵌入。运行配置直接列出带 commit 的任务，不在运行时使用浮动 registry 或 `main`。

| 日常任务 | 主要能力 |
| --- | --- |
| regex-log | 合法 IPv4、日期与字符边界、多个日期中的最后一个 |
| constraints-scheduling | ICS 可用时间、会议冲突、缓冲与偏好组合 |
| cobol-modernization | 陌生语言阅读、Python 迁移、连续交易文件行为 |
| cancel-async-tasks | 并发限制、SIGINT、取消传播与排队任务清理 |
| log-summary-date-ranges | 日期范围统计、干扰文本排除与 CSV 格式 |
| db-wal-recovery | SQLite/WAL 恢复、记录完整性与重复项处理 |

日常 6 题不是完整基准分数。保持模型、agent、数据版本与并发设置一致，才适合对比多次运行。

## 安装与启动

Go 主服务启动不要求 Harbor 或 Docker；只有运行 Terminal Bench 才需要它们。

```bash
# 在项目根目录执行，需要 uv、Python 3.12、Git 和可访问的 Docker/Compose
make terminal-bench-install
make backend
# 另一个终端
make frontend
```

可选环境变量：

```dotenv
TERMINAL_BENCH_BINARY=extensions/terminal-bench/.venv/bin/harbor
```

进入顶部「巡检引擎」，在左侧菜单选择「Terminal Bench」（窄屏使用引擎选择器），点击「检查环境」，确认固定版本 Harbor、Docker daemon、Compose 和 Git 可用。填写或选择浏览器保存的模型服务、API Key、模型 ID、协议，再选日常/完整题集。支持 Chat Completions、Responses 与 Messages，调用格式通过 Harbor `model_api_format` 明确指定；模型 ID 原样传递。

点击开始会真实调用模型，拉取任务及容器镜像并执行任务代码。默认并发 1，允许 1–4；本服务同时只允许一个 Terminal Bench 批次。完整 89 题的资源和额度消耗明显高于日常集，当前不设置金额预算。

Responses 对应 Harbor 的 `openai_responses` 格式，并由 Terminus-2 调用 Responses API；不会降级为 Chat Completions。选择保存的模型服务后，可以在本页面切换协议。

## 结果和取消

- 「巡检日志」中的 Terminal Bench 详情按题目显示等待、执行、通过、未通过、运行错误、中断/取消；取消测试操作也在该详情中。
- verifier 的 `reward=1` 显示通过；其他 reward 显示未通过；运行异常或没有 reward 显示运行错误。
- 最终历史保存于 `DATA_DIR/terminal-bench/<job-id>/job.json`，不含 API Key。
- 原始 Harbor 输出目录为同目录下的 `harbor/`；`input.json` 记录无密钥的固定运行参数。
- 每秒读取已落盘的逐题结果，浏览器每 3 秒刷新。正在初始化、下载或运行但尚未写出结果的题目仍显示等待，不伪造进度百分比。
- 取消向 Harbor 发送 SIGINT，等待最多 45 秒清理；超过时终止进程。强制终止或主机崩溃后需管理员检查残留容器。
- 服务端运行上限 24 小时。重启后原运行标记为中断，不会自动恢复或重新消费模型额度。
- 历史 artifacts 不自动清理，需要管理员自行管理磁盘空间；不支持多个服务实例共用同一个数据目录。

## 凭据和依赖边界

API Key 仅作为 `TB_MODEL_API_KEY` 传入本次 Harbor 子进程环境，不写入命令参数或 `input.json`，也不传递本应用登录密钥或其他供应商环境凭据。Harbor 的远端上传/launch 选项没有启用，遥测关闭。主服务不回显 Harbor stdout、异常详情或完整模型轨迹；界面展示白名单结果字段。

完整 Harbor artifacts 是本机诊断材料，可能含模型输出、任务轨迹和供应商错误，存放在权限受限的数据目录，不通过静态路由暴露。部署时应使用隔离的 Docker 工作机；本期未加入 SSH/远端 worker。

`extensions/terminal-bench` 是独立 Python 项目，不修改 Go 或 React 的运行依赖。后续升级 Harbor 或数据集时需同时更新锁文件、manifest、请求配置与结果解析测试。

## API

均需要本应用 Bearer 会话：

| 路径 | 功能 |
| --- | --- |
| `GET /api/v1/terminal-bench/catalog` | 固定的完整/日常题单及来源 |
| `GET /api/v1/terminal-bench/readiness` | 检查安装、Docker、Compose、Git |
| `GET /api/v1/terminal-bench/jobs` | 无密钥的运行历史 |
| `POST /api/v1/terminal-bench/jobs` | 启动 daily/full 固定题集，返回 202 |
| `GET /api/v1/terminal-bench/jobs/{id}` | 逐题进度和结果 |
| `POST /api/v1/terminal-bench/jobs/{id}/cancel` | 请求取消 |

创建请求字段：`suite`（daily/full）、`service_name`、`base_url`、`api_key`、`protocol`（chat_completions/responses/messages）、`model`、`concurrency`（1–4）。不能通过 API 指定任意脚本、agent、任务仓库、主机挂载或 CLI 参数。

## 验证边界

开发验证包括本地 mock runner 的任务集合、取消、防重、结果恢复与错误分类，以及真实 Harbor CLI 的无模型调用 dry-run。dry-run 不下载任务内容，也不证明镜像、题目依赖、模型额度或真实 verifier 全流程可用。实际评测须由用户填写目标模型并主动启动。

参考入口：

- https://github.com/harbor-framework/terminal-bench
- https://github.com/harbor-framework/harbor
- https://raw.githubusercontent.com/laude-institute/harbor/main/registry.json
