# 可插拔 SDK 与弱依赖

## 当前边界

项目区分两个独立接口，默认仅编译 Go 标准库实现。没有动态下载依赖、启动时自动安装 SDK 或运行时加载共享库。

| 扩展 | 接口 | 负责 | 内置实现 |
| --- | --- | --- | --- |
| 模型协议 | `pkg/provider.Provider` | 模型发现、统一文本调用、协议错误转换 | OpenAI 兼容 HTTP |
| 检测引擎 | `pkg/evaluator.Engine` | 题库、多次调用、判定、版本与结果映射 | smoke 1.0.0 |

厂商名与协议不是一回事。多个厂商或网关可能使用同一 OpenAI 兼容协议；目前界面选择的是适配器 ID，不宣称已支持各厂商原生 SDK。

## Provider

```go
type Provider interface {
    ID() string
    Name() string
    DiscoverModels(context.Context, Connection) ([]Model, error)
    Complete(ctx context.Context, connection Connection, modelID, prompt string) (Completion, error)
}
```

实现负责供应商差异、传输超时和安全错误信息。不得返回原始认证头、密钥、完整 upstream 错误体；必须响应 context 取消。不要在 Provider 中计算智力得分或选择本次扫描范围。

## Evaluator

```go
type Engine interface {
    Descriptor() Descriptor
    Run(context.Context, Target) (Report, error)
}
```

`Descriptor` 包含唯一 ID、名称、版本、说明。`Target` 含 `Model`、`Provider` 和仅运行期使用的 `Connection`。`Report.Checks` 是检查结果，状态限于 `passed`、`failed`、`error`。每项保留名称、输出、错误与延迟。

引擎可以自行组织多次 `Provider.Complete` 调用，也可以将 `Target.Connection` 传给自己隔离的评测 SDK。模型输出判定失败使用 `failed`；单项 API 错误使用 `error`；引擎无法继续时返回 error，可同时返回已经完成的部分 Report。禁止把执行异常伪装成低分或成功。

最小示例：

```go
package custom

import (
    "context"
    "llm-intelligence/pkg/evaluator"
)

type Engine struct{}

func (Engine) Descriptor() evaluator.Descriptor {
    return evaluator.Descriptor{ID: "custom", Name: "自定义检测", Version: "1.0.0"}
}

func (Engine) Run(ctx context.Context, target evaluator.Target) (evaluator.Report, error) {
    raw, err := target.Provider.Complete(ctx, target.Connection, target.Model.ID, "Reply with exactly: OK")
    if err != nil { return evaluator.Report{}, err }
    status := "failed"
    if raw.Text == "OK" { status = "passed" }
    return evaluator.Report{Checks: []evaluator.Check{{
        ID: "exact-ok", Name: "精确输出", Status: status,
        Output: raw.Text, LatencyMS: raw.LatencyMS,
    }}}, nil
}
```

在 `cmd/server/main.go` 依赖装配处显式注册引擎，检查 Register 错误。API 与前端会动态读取引擎列表，不需要硬编码前端下拉选项。现有 HTTP 集成测试用可选测试引擎验证过这条注册路径。

## 依赖隔离策略

默认模块不应该因为一个尚未启用的评测工具而需要 Python、GPU、重量级 SDK 或系统库。

- **纯 Go 的轻量实现**：实现放入独立适配器目录；第三方 SDK 较重时放入单独 Go module，在选择该扩展的构建中显式接入。
- **Python / Node / CLI SDK**：每个工具使用自己的依赖清单与虚拟环境/容器；未来通过独立 worker 或受控子进程包装成 Engine。当前仅规划此边界，未实现通用执行器或 RPC。
- **安装与启用分开**：可选依赖缺失时不注册该引擎，或在显式启用它时返回清晰启动错误；不能让默认服务启动依赖所有 SDK。
- **Go 的实际约束**：Go module 没有 npm 式 optionalDependencies。仅加 build tag 并不能保证 `go mod tidy` 忽略 SDK；需要独立 module/独立构建入口。默认 `go.mod` 应保持不包含这些可选 SDK。

建议在选定第一个真实 SDK 后确定 worker 的输入输出 schema、超时、退出码、凭据传递与版本固定方式。当前不引入空壳进程框架，也不提供“安装成功即自动兼容”的保证。

目录规划见 [../extensions/README.md](../extensions/README.md)。

## 扩展验证

每个适配器至少验证：正常结果、调用错误、取消/超时、凭据不外传。测试使用本地模拟服务，不读取真实 API Key。题库或判定方式变更必须增加引擎版本；需要通用数值指标时先扩展 Report 契约并说明分数定义，不擅自比较不同基准的分数。
