# Router Skill：包内资源与启用

Router 安装资源中提供：

- `runtime/skills/codex-router/SKILL.md`：可选 Codex Skill。
- `runtime/src/router-skill-cli.mjs`：与桌面相同宿主实现的调用入口。
- `runtime/node.exe`：随包提供，不需要用户另装 Node。

安装器只放置这些文件，不会自动启用 Skill、改 Codex 配置、启动 Router 或创建 Worker。文件哈希列于 `runtime/runtime-manifest.json`；开发候选仍受清单中的发布限制约束。

## 可选启用

确认安装目录、实际 Codex Skill 目录和 Router 配置文件路径后，将包内 `codex-router` 文件夹复制到所选的 Codex Skill 目录。若已有同名目录，先检查版本并备份，不直接覆盖。多套 Codex home 时不要猜测目标，也不要复制到所有 home。

此步骤是用户显式启用操作，不由 Router 安装器代办。Skill 本身不会携带 API Key，也不要求把 Key 写进提示词。安装后按当前客户端的 Skill 发现机制确认可见；不可见时先核对目录，不重复安装其他版本。

第一次调用时提供实际 Router 安装目录与配置路径。Skill 不绑定某台开发机，不搜索到第一份配置就使用。源码目录和已安装 runtime 不是同一版本：如果安装目录缺少 `router-skill-cli.mjs`，该安装尚不支持新入口。

## 使用

可请求“查看 Router 状态和当前网关”或“在指定项目创建 Router Worker，模型选某个已启用模型”。模型不明确时会询问，不自动选择。创建使用现有一次初始化，可能产生费用；服务未启动时只提示，不代为启动。

只读命令示例（先将三个变量设为已核实的绝对路径）：

```powershell
& $routerNode $routerEntry status $routerConfig
```

其中入口位于上述 `runtime/src/router-skill-cli.mjs`。不要把 API Key 当命令参数。

创建返回 operationId 和真实回执。发生超时或未知结果时查询原 operationId，不重建、不重发初始化。持久化成功不等于桌面重开验证，也不等于团队入组；Manager 的既有入组流程不变。

## 升级及移除

Router 更新不会覆盖用户已启用的 Skill。需要更新 Skill 时，比较包内版本、保留个人修改并明确替换。移除时只移除所选 Skill 文件夹；不会删除 Worker、网关或 Key，也不会停止服务。
