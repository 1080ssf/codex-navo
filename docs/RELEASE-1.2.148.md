# Codex Navo 1.2.148

## 中文

- 在“应用设置 → Codex CLI 运行依赖”中直接安装并使用官方稳定版 CLI，无需另开终端或手动配置路径。
- 提供下载、校验、解压、启动验证和启用进度；支持取消下载与失败重试，复用 Navo 的后台网络代理。
- 使用独立的版本目录，通过文件大小、SHA-256、版本和隔离 app-server 握手验证后才启用；失败不替换原配置，不覆盖桌面端、账号凭证或会话。
- 修复仅发现预发行版时一律拒绝的问题：稳定版优先；无可用稳定版时，仅允许通过启动握手的预发行版备用。
- 移除额度与模型读取使用的旧 `--stdio` 参数，采用 app-server 默认标准输入输出通道；保留原来的账号目录和代理传递。
- 完善 CLI 输入框及安装状态的简体中文、英文显示。

## English

- Install and select the official stable CLI directly from **App settings → Codex CLI runtime**, without opening a terminal or configuring a path manually.
- Track download, verification, extraction, handshake validation and activation. Cancel downloads or retry failures using Navo's background network route.
- Install into independent version directories. Validate size, SHA-256, version and an isolated app-server handshake before activation. Failures preserve the previous configuration; desktop binaries, account credentials and sessions are not overwritten.
- Prefer stable builds; allow a prerelease fallback only after a successful startup handshake when no stable CLI is available.
- Use app-server's default stdio transport for quota and model reads instead of the legacy `--stdio` flag, retaining the account home and proxy environment.
- Improve the CLI path field and localized installation status in Simplified Chinese and English.
