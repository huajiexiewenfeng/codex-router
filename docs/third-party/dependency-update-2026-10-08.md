# 候选包依赖安全更新 · 2026-10-08

本记录接续 [升级前检查](review-2026-10-08.md)。用户已确认只更新候选包的 Node 22.x 与相关前端依赖并回归；**不替换已安装 Router，不停止现用服务，不发模型请求，不发布 GitHub Release**。

## 本地现用版本核对

- 桌面 EXE 版本 0.1.3，文件时间仍为 2026-10-02；内置 Node 22.17.1。
- 已安装 runtime manifest 的 220 个文件校验一致；45 个顶层运行时源码与公开源码基线一致。这里只证明已检查安装目录的内容，不把它当作所有运行进程的来源或实时服务健康证明。
- 检查时 GitHub main 仍为 `6e28eea6534f6f4a95a20739888237cd8191931b`，未发布 Release。不是已有新版 Router 漏装，而是当前开发基线需要依赖安全更新。

## 修改范围

| 项目 | 升级前 | 候选 |
| --- | --- | --- |
| 内置 Node win-x64 | 22.17.1 | 22.23.3 |
| vite | 6.4.2 | 6.4.4 |
| baseline-browser-mapping | 2.10.42 | 2.11.27 |
| browserslist | 4.28.5 | 4.29.3 |
| nanoid | 3.3.15 | 3.3.20 |
| postcss | 8.5.16 | 8.5.29 |
| source-map-js | 1.2.1 | 1.2.2 |

Browserslist 的兼容关联更新：caniuse-lite 1.0.30001803 → 1.0.30001815、electron-to-chromium 1.5.389 → 1.5.451、node-releases 2.0.50 → 2.0.57、update-browserslist-db 1.2.3 → 1.3.4。锁文件合计 10 项版本变化，无主版本升级。

命令：先将 Vite 固定为 6.4.4，再执行 `npm update vite browserslist nanoid postcss source-map-js baseline-browser-mapping --ignore-scripts --no-audit --no-fund`。没有使用 `audit fix --force`。根项目依赖、Cargo 依赖、Router 源码、UI 逻辑、Rust 宿主逻辑均未修改。

前端新锁文件 SHA256：`8097d986b456816eaeeefecc817b90644a87e467ee1017dabdf08f5967b5fd58`。升级前清单保留为历史快照，其前端锁文件哈希不再代表当前候选。

## Node 来源与校验

22.23.3 来自检查时的 [Node 官方版本索引](https://nodejs.org/dist/index.json)，仍在 22.x，不跨主版本。[归档来源与哈希](node-v22.23.3/provenance.json) 记录 EXE、完整上游 LICENSE 和 SHASUMS256.txt。

- EXE SHA256：`9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e`，与官方校验行一致。
- Windows Authenticode：检查时 `Valid`，签名者 OpenJS Foundation。
- 未验证签名版 release manifest；打包脚本依然只强制哈希/声明一致性，不把该观察包装成新增签名验证能力。
- 旧 Node 归档保留供溯源，但不再作为当前打包基线。系统全局 Node 和现用 Router 内置 Node 均未替换。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| 新 Node 对旧打包器 | 隔离 stdio 集成按预期失败 `DR_NODE_UNREGISTERED`；更新固定基线后通过 |
| 新 Node 下后端全套 | 354 项，353 通过、1 跳过、0 失败；包含隔离 runtime 打包/服务启停/宿主重开 |
| 跳过项 | 原生已安装 Codex provider 集成，未开启显式 opt-in；没有伪装为已验收 |
| 前端测试 | 30 通过 |
| 前端构建与 Sites 测试 | Vite 6.4.4 构建成功，Sites 4 通过 |
| 前端 npm audit | 退出 0，128 个依赖包，0 个报告漏洞；升级前为 6 个受影响包 |
| runtime staging | 183 个文件哈希复核一致，Node 为 22.23.3，`distributable: false` |
| Windows EXE subsystem | 原生候选为 GUI subsystem，1 项检查通过；不等同于实际启动全链路无黑框验收 |

根 npm 上轮 audit 为 0 且锁文件未变；这不代表 Node/Rust 完整安全审计通过。测试均使用本地夹具，无真实模型请求。新 Node 影响运行时执行，因此本轮跑了后端全套；不是仅靠前端构建断言升级兼容。

## 桌面候选与下一步

临时 Tauri staging 覆盖候选版本为 **0.1.4**，用于区别现用 0.1.3；仓库 package/Cargo 基线仍为 0.1.3。这是按构建文档支持的本地版本覆盖，不是已发布 tag，也不代表 main 已更新。

Tauri/NSIS 构建已退出 0，完成 1 个 Windows x64 安装包：

- 构建命令（在 `apps/router-desktop`，PATH 包含 Rust 和候选 Node）：`node node_modules/@tauri-apps/cli/tauri.js build --debug --ci --config <stage>/tauri.installer.json -- --offline`。
- 文件：`apps/router-desktop/src-tauri/target/debug/bundle/nsis/Codex Router Preview_0.1.4_x64-setup.exe`。
- 大小：25,146,222 字节。
- SHA256：`80d0e6c8315d2ab96789a14ce7cd9637638ffa2ee9f119efcade8899e852e683`。
- Windows 签名状态：`NotSigned`。这是开发候选，不应直接安装到日常 Router 目录。

安装包生成不等于安装/升级/卸载已验收。现用 0.1.3 EXE 版本和文件时间未变，runtime 未替换；本轮没有执行安装器或打开候选桌面程序。

完整依赖 notices、Rust 安全审计、干净 Windows 首装/升级/卸载验收、发行签名和公开发布仍待完成，见 [验收矩阵](../windows-preview-readiness.md)。后续替换用户现用程序或重启共享 Router 必须另行确认。

## 2026-10-31：源码推送前复核

本节补充发布前检查，不改写上面的 2026-10-08 历史快照或安装包记录。此次只提交源码、锁文件和文档，不生成或发布新的安装包，不替换现用 Router，不启动共享服务或发送真实模型请求。

- 独立审查覆盖端口首次分配修复、依赖更新和新增文档，未发现阻断源码公开的缺陷或真实 Key/私人配置。已有非零端口保持不变；不会自动迁移现有 Worker。
- 刷新 npm audit 后发现后续公告：Vite 6.4.4 的中危 [GHSA-8g5g-mxqh-grgj](https://github.com/advisories/GHSA-8g5g-mxqh-grgj)，以及 Undici 7.29.1 的多项高危/中危公告（见 [7.30.1 官方安全修复说明](https://github.com/nodejs/undici/releases/tag/v7.30.1)）。这不证明本项目的每种漏洞路径均可达。
- 仅将 Vite 固定为 6.4.5、Undici 固定为 7.30.1；两次安装均使用 `--save-exact --ignore-scripts --no-audit --no-fund`，各仅改变一个依赖包，无主版本升级、无新增依赖。Node 固定基线仍为 22.23.3；未改 Router 请求/响应语义、Prompt 或权限策略。
- 最终根锁文件 SHA256：`6f28ca70223cb1a24ced8714c003d98b37555e512156557d7ff39babae4747a5`。
- 最终前端锁文件 SHA256：`ffddae915090c89ce63139232c8ca6383c67219aadf80e71c667d91e1d9ed3d0`。旧 inventory 保留为升级前快照，不代表当前依赖版本。
- 两处 `npm audit --json --package-lock-only --ignore-scripts` 均退出 0，报告漏洞为 0；不能代替 Node 内置组件、Rust 或完整分发审计。
- 使用校验匹配归档的 Node 22.23.3：前端含 Sites 共 34 项测试通过，Vite 6.4.5 构建与 Sites 打包成功。后端共 356 项，355 通过、1 跳过、0 失败；包含新 Undici 下的流式请求、官方代理与隔离 runtime 打包/启停/宿主重开。跳过的是未显式启用的已安装 Codex provider 集成，不把它当作原生验收通过。

源码通过验证不表示旧 0.1.4 开发安装包已包含这次端口和依赖修复。二进制发行仍以 [Windows 验收矩阵](../windows-preview-readiness.md) 中尚未完成的条件为准。
