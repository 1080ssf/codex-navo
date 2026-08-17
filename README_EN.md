# Codex Navo

[简体中文](README.md) · **English**

> Open-source Codex multi-account workspace for Windows with account isolation, quota and token tracking, OpenAI-compatible API pooling and failover, per-account proxies, session management, notifications, and a floating status window.

[![Release](https://img.shields.io/github/v/release/1080ssf/codex-navo?display_name=tag&style=flat-square)](https://github.com/1080ssf/codex-navo/releases/latest)
[![License](https://img.shields.io/github/license/1080ssf/codex-navo?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Windows-11%20x64-1672F3?logo=windows11&logoColor=white&style=flat-square)](#install-and-get-started)
[![Telegram](https://img.shields.io/badge/Telegram-Join-26A5E4?logo=telegram&logoColor=white&style=flat-square)](https://t.me/+4VH9hBsRu7phNjg1)
[![QQ](https://img.shields.io/badge/QQ-Join-12B7F5?logo=tencentqq&logoColor=white&style=flat-square)](https://qm.qq.com/q/f92ySNuLss)

<p>
  <a href="https://github.com/1080ssf/codex-navo/releases/latest"><strong>Download latest release</strong></a>
  · <a href="https://1080ssf.github.io/codex-navo/">Project website</a>
  · <a href="CHANGELOG.md">Changelog</a>
  · <a href="#install-and-get-started">Documentation</a>
  · <a href="https://github.com/1080ssf/codex-navo/issues">Report an issue</a>
</p>

![Codex Navo account pool overview](docs/images/codex-navo-account-overview.jpg)

## Contents

- [Why Codex Navo](#why-codex-navo)
- [Core advantages](#core-advantages)
- [Feature overview](#feature-overview)
- [OpenAI-compatible API](#openai-compatible-api)
- [Network proxies](#network-proxies)
- [Project and session management](#project-and-session-management)
- [Notifications and floating window](#notifications)
- [Install and get started](#install-and-get-started)
- [FAQ](#faq)
- [Community and support](#community-and-support)
- [Run from source](#run-from-source)

## Why Codex Navo

**Manage multiple Codex accounts in one application. Account isolation, quota monitoring, proxy routing, and API-pool failover help account switches happen without unnecessarily interrupting your work.**

Manually changing authorization becomes disruptive as accounts, projects, proxy routes, and Codex sessions grow. Codex Navo brings these workflows into a local-first desktop application. Each standard account has its own isolated environment while local projects and sessions remain available. Multiple accounts can also form an OpenAI-compatible API pool that tries another eligible account after quota exhaustion, rate limits, or retryable upstream failures.

### Core advantages

- **Real account isolation:** every standard account uses its own Chrome profile, cookies, web login, and Codex OAuth authorization.
- **Switch without losing work:** Navo switches account authorization rather than replacing project directories. Choose the language, projects, and sessions to load when starting Codex.
- **Unified account management:** standard accounts, temporary credentials, and API Codex groups share compact card/list views, sorting, and collapsible sections.
- **Quota and usage at a glance:** inspect 5-hour and weekly limits, credits, balance, reset time, input, cached input, output, cache rate, and token estimates.
- **Built-in API account pool:** expose authorized accounts through OpenAI-compatible endpoints with per-key account order, model access, authorization, and automatic failover.
- **End-to-end proxy routing:** route login, OAuth, quota refresh, keep-awake requests, Codex launches, and API requests through account- or API-key-specific lines.
- **Project and session management:** group active, failed, archived, and all sessions by project, with archive, delete, and failed-record cleanup actions.
- **Visible task status:** notifications, sounds, and a floating window show the active account, quota, task progress, and per-task token usage.
- **Local-first storage:** account configuration, nodes, usage data, and session indexes stay on the machine. Navo API keys are stored only as salted hashes and the complete key is shown once at creation.

## Feature overview

| Module | Main capabilities |
| --- | --- |
| Account management | Isolated Chrome profiles and OAuth, standard/temporary/API groups, quota refresh, card/list views |
| Start Codex | Proxy preflight, selective project and session loading, language choice, launch progress |
| Usage | Today/yesterday/7-day/30-day/all-time input, cached input, output, cache rate, model calls, estimates |
| API service | `/v1/models`, `/v1/responses`, `/v1/chat/completions`, account-pool failover |
| Network proxy | Subscriptions and single nodes, progressive testing, latency sorting, per-account/per-key routing |
| Sessions | Project grouping, active/failed/all/archived views, archive, delete, failed-list cleanup |
| Notifications | Windows, Feishu, DingTalk, Telegram, custom message text, imported local sounds |
| Floating window | Active account, quota, global/task tokens, progress, style, opacity, always-on-top, recall shortcut |
| Settings | Navo/Codex default language, Navo updates, in-app Codex updates, community links |

## Accounts and usage

Card view provides complete information for each account, while list view stays compact for larger pools. API Codex quota bars aggregate the available quota of bound accounts; standard and temporary accounts show their own quota and state.

![Account card view](docs/images/codex-navo-account-overview.jpg)

![Account list view](docs/images/codex-navo-account-list.jpg)

Local usage can be filtered by today, yesterday, the last 7 or 30 days, or all time. Cache rate is cached input divided by total input. Token estimates use public API token prices only and do not represent actual Plus or Pro subscription charges.

## Add accounts and temporary credentials

The **Add account** dialog provides four entry points:

1. **Sign in and authorize:** complete the official login and Codex OAuth flow in the account's isolated Chrome profile.
2. **Import an existing account:** import a `.codexnavo` authorization package.
3. **Create API:** create the same type of Navo API key available on the API service page. The complete key is shown only once.
4. **Import a third-party package:** read JSON packages from Sub2API, CLIProxyAPI, Cockpit, 9router, AxonHub, and similar tools to create temporary credentials used only for reverse proxying.

Temporary credentials have the same quota, proxy, keep-awake, and API-pool capabilities as standard accounts, but do not create a web profile or launch Codex independently.

![Add account and import options](docs/images/codex-navo-add-account.jpg)

## OpenAI-compatible API

The API service combines selected standard and temporary accounts into a local account pool. Each Navo API key can define its own account access and order, model permissions, network proxy, and enabled state.

When an account exhausts its quota, is rate-limited, loses authorization, or encounters a retryable upstream failure, the router cools it down and tries the next eligible account. The default base URL is:

```text
http://127.0.0.1:18300/v1
```

Supported compatible endpoints:

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
```

![API service and Navo API keys](docs/images/codex-navo-api-service.jpg)

> The isolated demo instance in the screenshot uses port `18390`. Production builds default to `18300` and reserve `18301-18399` for reusable local proxy entries.

See the [API service guide](docs/api-service.md) for configuration and request examples.

## Network proxies

Codex Navo includes the Mihomo network core and accepts subscriptions, multi-node configurations, and individual proxy nodes. Test results appear as each node completes; after the run, available nodes are sorted by latency.

Supported common formats and protocols include HTTP, HTTPS, SOCKS5, SS, SSR, VMess, VLESS, Trojan, Hysteria/Hysteria2, TUIC, WireGuard, and common Clash/Mihomo subscriptions and node links.

Routes can be assigned to standard accounts, temporary credentials, and Navo API keys. An account proxy covers login, OAuth, quota refresh, keep-awake calls, and Codex launched from Navo. An API-key proxy applies to requests made through that key's account pool.

![Proxy subscriptions, nodes, and checks](docs/images/codex-navo-network.jpg)

## Project and session management

The Sessions page reads local Codex sessions and groups them by project. It distinguishes running, waiting, completed, failed/interrupted, and archived states. Project groups are collapsible; problematic sessions can be archived or deleted individually, while failed records can be removed from the UI only or together with the matching local data.

![Project-grouped sessions](docs/images/codex-navo-sessions.jpg)

## Notifications

Task completion, failure, and attention events can use Windows notifications or send exactly the user-entered message to configured channels. Current channels include Feishu, DingTalk, and Telegram. Notification sounds include built-in choices and imported local audio files.

![Notification channels, messages, and sounds](docs/images/codex-navo-notifications.jpg)

## Floating window

The floating window shows the active account, quota progress, input/cached input/cache rate/output, current task, task progress, and task-specific tokens. It supports multiple styles, adjustable opacity, always-on-top behavior, and recall from Navo, the system tray, or `Ctrl+Alt+N`.

<p align="center">
  <img src="docs/images/codex-navo-floating-window.jpg" alt="Codex Navo floating window" width="400">
</p>

## Keep-awake requests

Wake one or all accounts manually, or schedule daily and post-reset wake-ups. Wake-ups send real Codex requests and support model, reasoning-effort, and prompt selection.

![Account wake-up policy](docs/images/codex-navo-wake.jpg)

## Language, updates, and community

On first launch, the application follows the Windows language and uses it as the default Codex launch language. The interface language can then be selected independently in Settings. Updates are managed separately: Navo checks GitHub Releases, while Codex official versions are checked and installed inside Navo.

Settings also contains Telegram, QQ, and GitHub community links.

![Language, updates, and community](docs/images/codex-navo-app-settings.jpg)

## Install and get started

### 1. Download

Open [Releases](https://github.com/1080ssf/codex-navo/releases/latest) and download:

```text
Codex-Navo-Setup-<version>-windows-x64.exe
```

Recommended environment:

- Windows 11 x64
- Google Chrome
- Codex desktop application
- Codex CLI

### 2. Add an account

Open Codex Navo, select **Add account**, then choose **Sign in and authorize**. Navo opens an isolated Chrome profile where you complete the official OpenAI login and Codex OAuth flow.

### 3. Start Codex

Select **Log in to Codex** on the account card. Launch progress reports proxy checks, project/session loading, and application startup. The selector can load all or only chosen projects and sessions to reduce startup time with large histories.

## Authorization packages and data location

The authorization migration page checks account status and exports or imports `.codexnavo` files. These packages may contain valid Codex authorization and web sessions and must be protected like account credentials. They do not contain passwords, projects, tasks, browsing history, or cookies from unrelated websites.

Runtime data is stored by default in:

```text
%LOCALAPPDATA%\Codex Switchboard
```

The legacy directory name is preserved for upgrade compatibility. It is not committed to GitHub. Do not publish unredacted screenshots, authorization packages, or complete logs.

## FAQ

### Do projects and sessions disappear after switching accounts?

No. Codex Navo changes Codex authorization, not local project directories. You can also choose which projects and sessions to load at startup.

### Do accounts share cookies?

Standard accounts use separate Chrome profiles and do not share web cookies. Temporary credentials are reverse-proxy-only and do not have browser profiles.

### Can multiple Codex desktop instances run at once?

Codex desktop is a single-instance application. One standard account or API Codex uses it at a time, while multiple isolated web profiles can remain open separately.

### Why does Navo keep running after I close the main window?

Navo stays in the Windows system tray to run notifications, wake-ups, the API service, and the floating window. Right-click the tray icon and select **Exit application** to stop it completely.

### What do cache rate and token estimate mean?

Cache rate is cached input divided by total input. Token estimates use public API token pricing for reference and do not represent charges against subscription accounts.

## Community and support

- [Telegram group](https://t.me/+4VH9hBsRu7phNjg1)
- [QQ group](https://qm.qq.com/q/f92ySNuLss)
- [GitHub repository](https://github.com/1080ssf/codex-navo)
- Submit feature requests and bugs through [GitHub Issues](https://github.com/1080ssf/codex-navo/issues).
- Report security issues through GitHub Private Vulnerability Reporting; see [SECURITY.md](SECURITY.md).

Never include real accounts, complete logs, authorization files, proxy subscriptions, or unredacted screenshots in public reports.

## Run from source

<details>
<summary>Expand development and build instructions</summary>

Node.js 20 or later is required:

```powershell
git clone https://github.com/1080ssf/codex-navo.git
cd codex-navo
npm install
Copy-Item config/settings.example.json config/settings.json
npm run dev
```

Test and build:

```powershell
npm test
npm audit --audit-level=high
npm run build:desktop
```

The installer is generated in `release/auto-update/`.

</details>

## Important notes

- Codex Navo is primarily tested on Windows 11 x64.
- Installers are not yet commercially code-signed, so Windows SmartScreen may show an unknown-publisher warning.
- The application uses official OpenAI login and authorization flows; final login status is determined by OpenAI's services.
- Let active tasks finish before switching or signing out of an account.
- Codex Navo is an independent, unofficial project and is not affiliated with or endorsed by OpenAI.

## License

[MIT License](LICENSE)

## Code signing policy and privacy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- [Code signing policy](CODE_SIGNING_POLICY.md)
- [Privacy policy](PRIVACY.md)
- Signed installers are published only through the [official GitHub Releases page](https://github.com/1080ssf/codex-navo/releases).
