# Codex Router

English | [简体中文](README.md)

A local desktop router for Codex: manage custom API gateways and models while keeping official model access.

**Source preview · 0.1.3.** Windows x64 is the primary development platform. This is an independent community project, not an official OpenAI product. No signed, distribution-reviewed installer is included in this initial source release.

## Features

- Save multiple gateways and select one active gateway for custom requests from all Router Workers.
- Discover models from compatible gateways, enable selected models, and distinguish them with `_self` aliases in the native model menu.
- Keep official model routing independent; no automatic provider fallback or replay of uncertain requests.
- Manage local service lifecycle, model catalog synchronization, diagnostics and stale-state recovery.
- Create Router Workers in local projects through the desktop UI or optional Skill/CLI.
- Store gateway keys locally using Windows DPAPI encryption.

The router is not a prompt-management system. It does not rewrite assistant instructions to control behavior, fabricate progress, invent tool call IDs, delete tool results or alter conversation history.

## Getting started

Build the desktop preview using [the build guide](docs/building.md), add a Responses-compatible gateway and your key, choose enabled models, select the active gateway, and start Router. Follow the UI to configure the Codex connection and create a Router Worker. Then select an official model or a custom `_self` model in that Worker's native model menu.

An installed, signed-in Codex client is required. Worker initialization can incur model charges; optional model verification also sends a real request. Saving a configuration or discovering a model name does not prove upstream availability or capability.

## Development

Requires Node.js 22.12+ and npm. Desktop builds additionally require Rust/MSVC, Windows SDK and WebView2.

```powershell
npm ci
npm test
npm --prefix apps/router-desktop ci
npm --prefix apps/router-desktop test
npm --prefix apps/router-desktop run build
```

The browser preview is UI-only. Native Worker and model-menu integration is sensitive to Codex versions. Other operating systems, clean-machine installation, release signing, complete dependency review and automatic updates are not yet production-validated. See [security notes](SECURITY.md) and [Skill setup](docs/router-skill-setup.md).

The packaged-runtime integration test requires the archived Node v22.23.3 win-x64 binary; set `CODEX_ROUTER_TEST_NODE` to its verified absolute path when using another Node version. Otherwise that test is explicitly skipped. Installed-Codex integration is opt-in; default tests do not send real model requests.

Extracted from [codex-team-runtime](https://github.com/huajiexiewenfeng/codex-team-runtime), retaining only Router dependencies. Team admission and task orchestration remain separate concerns.

## License

MIT — [LICENSE](LICENSE). Dependencies and Phosphor icons retain their own notices. Never include credentials or private conversations in public issues or pull requests.
