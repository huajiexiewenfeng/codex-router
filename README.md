# Codex Router

[English](README.en.md) | 简体中文

**让 Codex 的官方模型和自定义网关共用一个工作入口。**

Codex Router 是面向 Windows 的本地代理与桌面管理工具。配置自己的 API 网关、Key 和模型，在 Router Worker 中使用带 `_self` 后缀的自定义模型，同时保留官方模型访问路径。

> **源码预览版 · 0.1.3**：已在开发者本机使用，仍在持续开发。这次发布源码，不提供经过签名和完整发行审查的安装包。不属于 OpenAI 官方产品，也未获得 OpenAI 背书；模型可用性取决于账号、客户端和上游网关。

## 能做什么

- **管理网关**：保存多个网关，同时选择一个当前网关，供所有 Router Worker 的自定义模型请求使用。
- **管理模型**：从兼容网关同步模型列表，选择启用的模型，使用 `_self` 菜单别名区分官方模型。
- **保留官方入口**：官方模型使用独立的官方路由；不因公司网关失败而自动切换模型或网关。
- **本地桌面管理**：管理服务启停、模型菜单同步、请求诊断与异常状态恢复。
- **创建 Router Worker**：在指定本地项目创建对话，也提供可选 Skill/CLI 入口。
- **保护凭据**：Windows DPAPI 加密保存网关 Key，不将 Key 写入 Skill 或上传到本仓库。

Router 负责路由和必要的协议处理，不是提示词系统：不替用户重写助手指令、不伪造进度消息、不补造工具调用 ID、不删除工具结果或修改对话历史。

## 使用流程

1. 构建并启动桌面预览（见 [构建说明](docs/building.md)）。
2. 添加网关：填写名称、Base URL、API Key，同步或手动填写模型并选择启用项。当前面向兼容 **Responses API** 的网关，不是任意厂商协议转换器。
3. 设为当前网关并启动 Router。保存配置不等于已通过模型验证。
4. 按界面提示检查 Codex 接入配置，创建 Router Worker；需要时重开 Codex。
5. 在该 Worker 的原生模型菜单选择官方模型或自定义 `_self` 模型。

普通官方对话不会自动变成 Router Worker。模型切换后是否可用取决于真实上游能力，不能只凭菜单出现就判断成功。创建 Worker 包含一次模型初始化，可能产生费用；模型验证是可选诊断。

## 当前边界

- 主要针对 **Windows x64**；其他平台未验证。需要已安装且已登录的 Codex。
- 自定义模型需由网关真实支持；同步到模型名不代表上下文长度、工具调用或推理强度已验证。
- 超时、取消和断流可能意味着上游仍已执行，不自动重发结果不明的请求。
- 原生 Worker 接入和菜单兼容性受 Codex 版本影响；不能承诺所有未来版本无需适配。
- 浏览器/Vite 页面是交互预览，不能代替桌面宿主启动真实 Router。
- 安装器构建仍是开发流程。签名、完整依赖审查、干净 Windows 安装验收与自动更新尚未完成；不要把本机候选安装包当正式发行版。

## 开发

开发环境：Node.js 22.12+、npm；桌面编译还需 Rust/MSVC、Windows SDK 和 WebView2。

```powershell
npm ci
npm test
npm --prefix apps/router-desktop ci
npm --prefix apps/router-desktop test
npm --prefix apps/router-desktop run build
```

[桌面与安装包构建](docs/building.md) · [Skill 使用](docs/router-skill-setup.md) · [安全说明](SECURITY.md)

打包集成测试需要归档的 Node v22.23.3 win-x64；使用其他 Node 时会明确跳过该项，可通过 `CODEX_ROUTER_TEST_NODE` 指定已校验的二进制。原生 Codex 集成按测试中的显式环境开关启用；默认测试不发送真实模型请求。

## 项目结构

```text
apps/router-desktop/   React 界面与 Tauri Windows 宿主
src/                  Router、桌面配置桥、Worker 接入及公共依赖
test/                 离线测试和虚拟夹具
scripts/              开发打包与 Windows 凭据处理
skills/codex-router/   可选 Codex Skill
docs/                 构建、使用与第三方声明
```

项目从 [codex-team-runtime](https://github.com/huajiexiewenfeng/codex-team-runtime) 中拆出，保留 Router 所需的公共模块；不包含团队调度器、Dashboard 或开发者本机数据。Router 可以独立使用，团队入组、分派和验收仍由 team runtime 管理。

## 贡献与许可

欢迎提交 Issue 和 PR。报告错误时提供版本、操作步骤、脱敏错误码和预期结果，**不要上传 Key、凭据文件、完整会话或未脱敏日志**。修改应聚焦既定范围，参见 [AGENTS.md](AGENTS.md)。

MIT，见 [LICENSE](LICENSE)。Phosphor 图标和其他依赖保留各自许可证，见 [第三方声明](docs/third-party/README.md)。
