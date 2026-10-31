# Windows 开发构建

这是源码预览的开发构建，不是正式安装包发布流程。源码不含 Node EXE、私有配置或凭据，现有日常 Router 不会被这些命令自动更新。

## 前端与测试

在仓库根执行 README 的 `npm ci`、`npm test` 及桌面子目录命令。`npm --prefix apps/router-desktop run dev` 可预览界面，但浏览器页面不提供真实服务管理能力。

## 完整桌面候选

Windows 构建机需已配置 Rust 的 MSVC 工具链、C++ 构建工具、Windows SDK、Node/npm。运行桌面窗口需 WebView2；安装候选在缺少 WebView2 时使用下载引导程序，因此不是完整离线包。

当前 runtime 打包器仅接受已归档的 **Node v22.23.3 win-x64**。从 `docs/third-party/node-v22.23.3/provenance.json` 中列出的官方地址获取二进制，并核对该文件记录的 SHA256。这是候选包开发基线，不代表完整安全审查通过，正式发行前仍需复审；不会自动更新已安装的 Router。

在 PowerShell 中，将下面三个变量替换为本机真实路径。staging 必须不存在、父目录存在，且与源码在同一个盘符。

```powershell
$routerStage = 'D:/build/codex-router-stage'
$routerNode = 'D:/tools/node-v22.23.3/node.exe'
$routerNodeHash = '9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e'
node scripts/prepare-desktop-installer.mjs $routerStage $routerNode $routerNodeHash
Push-Location apps/router-desktop
node node_modules/@tauri-apps/cli/tauri.js build --debug --bundles nsis --config "$routerStage/tauri.installer.json"
Pop-Location
```

输出位于 `apps/router-desktop/src-tauri/target/debug/bundle/nsis/`。直接 `cargo build` 不等同于完整 Tauri 前端打包。默认源码版本保持开发基线，临时构建版本可在生成的覆盖配置中指定；不要将其当成配置 schema 版本。

**安装候选前先停止现有 Router 并关闭管理窗口。** 安装器不会为正在运行的后台服务完成安全迁移。不要把静默安装当成停止服务的替代方式。通过 Windows 资源管理器打开安装后的桌面程序；受管进程启动可能被生命周期保护拒绝。

runtime 与用户数据分离，数据默认位于 `%LOCALAPPDATA%/CodexRouterPreview/state-v1`。升级、恢复前保留备份；不要把该目录复制进源码或 GitHub。关闭桌面管理窗口不等于停止共享 Router 服务。

## 可选 Skill

候选安装目录包含 `runtime/skills/codex-router/SKILL.md`、`runtime/src/router-skill-cli.mjs` 和内置 Node。按 [Skill 使用说明](router-skill-setup.md) 手动启用，不自动改全局 Codex 配置。

## 发行前仍需完成

执行顺序和干净 Windows 验收矩阵见 [Windows 预览安装版准备](windows-preview-readiness.md)。[2026-10-08 依赖检查](third-party/review-2026-10-08.md) 是升级前快照，[后续候选更新](third-party/dependency-update-2026-10-08.md) 记录了依赖修复和回归；仍不应将开发安装包直接发布。

- 完整依赖许可证与安全审查、可复现构建和发行签名。
- 干净 Windows（无开发工具）安装、升级与卸载验证。
- 对目标 Codex 版本进行原生 Worker/官方与自定义模型切换验收。

因此 runtime manifest 保留 `distributable: false`，本次只发布源码，不发布 EXE Release。
