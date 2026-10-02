# Security / 安全说明

This project is an early source preview, not a security-audited gateway. Run it only on a machine and with upstream providers you trust.

- 自定义模型请求会将对话上下文发送到所选网关。请确认你有权向该网关发送代码和数据。
- 优先使用 HTTPS；HTTP 可能明文传输 Key 和内容。DPAPI 保护本地静态存储，不保护网络传输，也不能抵御同一 Windows 用户下的恶意程序。
- 不公开 Key、DPAPI 文件、凭据清单、原始请求/响应、Codex 会话、认证文件或用户状态目录。
- 公开 Issue 只提供脱敏错误码、版本与复现步骤。涉及可利用漏洞或秘密时，请使用 GitHub 的私密安全报告入口（若已启用），不要在公开 Issue 展示细节。
- 不自动重试结果不明的请求；断开连接不代表上游未计费或未执行。
- 不把恢复状态、服务端口打开或菜单可见当作上游模型已验证的证据。

The initial public repository contains source and synthetic test fixtures only. Developer installer candidates remain unsigned and are not approved for general binary distribution.
