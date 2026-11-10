# 可选扩展目录

此目录目前只有规划，没有安装第三方评测 SDK。内置 smoke 实现在 `internal/evaluators/smoke`。

当实际接入工具时，按以下职责组织，不提前创建空实现：

```text
extensions/
├── evaluators/
│   └── <sdk-name>/
│       ├── README.md          # 安装、启用、能力、版本和测试方法
│       ├── go.mod             # 纯 Go 扩展的独立依赖清单（如适用）
│       ├── pyproject.toml     # Python SDK 的独立环境（如适用）
│       └── ...                # SDK 包装与结果转换
└── providers/
    └── <vendor>/              # 原生厂商协议 / SDK 适配器
```

每个扩展只使用所需的一种依赖清单。核心通过 `pkg/provider` / `pkg/evaluator` 接口调用，默认根模块不依赖此目录下的外部运行时。

当前注册方式是编译时显式装配。跨语言 worker 与通信协议在首次实际接入时设计，尚未实现。详见 [插件指南](../docs/plugin-sdk.md)。
