---
name: codex-router
description: Use when the user asks to inspect local Codex Router status or the current gateway, or create a Router Worker in a specified project.
---

# Codex Router

复用产品宿主，查询状态或创建独立 Router Worker；不代表 codex-team-runtime 入组。团队任务仍遵循 Manager 的创建许可、登记及验收流程。

## 入口

先定位用户实际使用的 Router 安装目录和配置。使用该版本的 `runtime/node.exe` 与 `runtime/src/router-skill-cli.mjs`；源码开发环境为仓库的 `src/router-skill-cli.mjs`。所有路径传绝对路径，用 PowerShell 调用运算符 `&` 正确引用路径。

配置路径必须来自已确认的安装/配置记录，不按当前目录或搜索到的第一份配置猜测。入口文件不存在表示已安装版本尚未支持此功能：报告需要更新，停止创建，不自行升级或拼装 `node -e` 替代流程。

以下 `$routerNode`、`$routerEntry`、`$routerConfig` 均为已核实的绝对路径；参数不是 API Key。

| 请求 | 命令参数 |
|---|---|
| 查询服务、当前网关、已启用模型 | `status <routerConfig>` |
| 准备创建，不发模型请求 | `prepare <routerConfig> <input.json>` |
| 执行已确认的初始化并等待回执 | `start <routerConfig> <operationId> --confirm-initialization` |
| 恢复查询，不重发 | `job-status <routerConfig> <operationId>` |

## 创建流程

1. 查询 `status`。结果是本地状态，不保证上游可用。服务未运行、无当前网关或状态异常时说明缺口，等待用户处理；不自动启动服务、切换网关或改配置。
2. 核实目标项目路径、标题及精确模型。标题以 `Router-` 开头；模型缺失时询问用户，不擅自选默认或回退模型。公司模型从当前网关已启用的 `_self` 名称选择；官方模型不能假定此列表包含，须另有已确认名称。
3. 明确告知创建沿用产品的一次初始化，可能产生模型费用，不自动执行业务任务。已有覆盖该初始化的明确授权不重复询问；没有时先确认。不要改初始化提示词或权限。
4. 创建仅包含以下三字段的 UTF-8 JSON（使用用户真实选择）：

   ```json
   {"cwd":"D:/projects/example","title":"Router-测试","model":"gpt-6-sol_self"}
   ```

5. 执行 `prepare`，记录返回的 `operationId` 后再执行 `start`：

   ```powershell
   & $routerNode $routerEntry prepare $routerConfig $routerInput
   & $routerNode $routerEntry start $routerConfig $routerOperationId --confirm-initialization
   ```

   `start` 先输出进度，再等待最终回执。保留终端执行会话并等待同一次命令，不因执行工具先返回会话 ID 就重发命令。
6. 返回实际 `operationId`、`status`、已知的 `codex://threads/<threadId>` 链接，以及桌面重开是否验证。只有真实回执可作为创建证据；`persistenceVerified` 不等于 `desktopVerified`，更不等于团队 ready。

## 中断与错误

超时、异常或 `needs-reconciliation`：只运行 `job-status` 查询原编号并报告。已知 threadId 始终保留；结果不明不换编号重建、不删除回执、不重发初始化。不读取或显示凭据，不修改历史、模型指令或已有 Worker。

若是 codex-team-runtime 旧 CLI 创建、只有原始回执而没有 `.job.json` 的历史操作，需回到原工具已核实的 `src/cli.mjs worker-create-status <receipt.json>` 只读对账（本独立仓库不提供该旧 CLI）；入口不可用时报告边界，不要转换为新创建。

已明确的只读请求只运行 `status` / `job-status`。不调用 `worker-router-ensure`，不通过普通 create_thread 或跨对话发消息冒充 Router 创建。
