# Changelog

## 1.2.89

- Renamed the imported-account health label from Relay Credential Ready to Temporary Credential Ready.

## 1.2.88

- Fixed live API Codex proxy switching by tracking both `ChatGPT.exe` and the current `codex.exe` process family, preventing active gateway credentials from being restored too early during reconnects.
- Added validation and automatic rollback when changing the proxy of a running API Codex, so an unavailable route is not left active.
- Added a route test action to the per-account network dialog and made network source fields reliably receive focus.
- Compacted single-node proxy rows and removed the Temporary badge from imported account cards while retaining the Temporary Accounts group.

## 1.2.87

- Redesigned Add Account around four clear entry paths: official authorization, existing-account import, Navo API Key creation, and third-party package import.
- Moved third-party package import into Add Account, renamed relay-only entries to Temporary Accounts, and reduced imported cards to a single Temporary badge.
- Reused one API Key creation flow across Add Account and API Service, with a one-time full-key result, Copy action, and persistent dialog footer.
- Changed new API Keys to start with no accounts selected and grouped the account picker into independently collapsible Regular and Temporary sections.
- Added live per-account Codex model detection through `model/list`, preventing Free accounts from inheriting unavailable paid-account models and avoiding unsupported accounts during routing.
- Fixed API Codex recovery after an exhausted account by retaining its launch-scoped local gateway credential across app-server reconnects.
- Added account-pool cooldown and retry handling for quota, authorization, rate-limit, and transient upstream failures so requests can continue through the next configured account.
- Extended proxy import to accept descriptive text files and split SOCKS5 fields while preserving precise Cloudflare-blocked, region, and connectivity results.

## 1.2.86

- Added third-party relay-account import for Sub2API/toSub2, CPA/CLIProxyAPI, Cockpit, 9router, AxonHub, Codex auth.json, Codex-Manager, and raw access-token packages.
- Added a separate collapsible relay-account group whose cards participate in the local API pool while keeping Web and Codex Desktop launch actions disabled.
- Added automatic OAuth refresh for complete imported credentials and expiration-aware temporary routing for access-token-only packages.
- Synchronized floating-window text immediately when the Codex Navo application language changes.
- Added an API Codex proxy preflight stage so its assigned route is validated before shared Codex state changes or Codex Desktop opens.
- Refined the relay import dialog and gave its unavailable import action an explicit disabled appearance.

## 1.2.85

- Added an always-available close action to the Codex launch progress card without interrupting the background launch.
- Fixed completed launch progress remaining visible because polling repeatedly restarted its auto-hide timer; completed cards now close once after a short confirmation delay.
- Kept manually dismissed launch progress hidden for the current launch while preserving background progress and launch-button state updates.
- Fixed the application becoming unresponsive after switching away from Chinese by preventing the live translation observer from rewriting unchanged text and recursively triggering itself.

## 1.2.84

- Fixed API Codex HTTP 400 responses by preserving the native Codex cache request shape instead of injecting unsupported prompt-cache breakpoint fields, and added sanitized upstream error details for diagnostics.
- Added a live Codex launch progress panel with real proxy, project/session, credential, warm-up, and startup stages while preventing duplicate launch clicks.
- Moved the local OpenAI-compatible API to port 18300 and added a reusable, collision-aware proxy port pool from 18301 through 18399.
- Changed subscription-wide node checks to publish each result immediately, keep testing in the background, and reorder usable nodes by latency as results arrive.
- Fixed excess blank space below short node lists and aligned the API Key name field and account-order section in the permissions dialog.

## 1.2.83

- Renamed Language Settings to Application Settings and added aligned update cards for Codex Navo and Codex Desktop.
- Added in-app Codex Desktop updates through the official Windows `msstore` package source, including running-process protection and installed-version reporting.
- Added Telegram, QQ, and GitHub community links with dedicated vector icons and system-browser handling.
- Reset persisted API usage expansion on startup so API and regular account cards begin at the same list-view height while retaining click-to-expand usage details.

## 1.2.82

- Verified cache-rate calculations against raw Codex token events and added stable GPT-5.6 prompt-cache keys and explicit developer-prefix cache boundaries for API Codex requests.
- Added API cache-write Token tracking so new GPT-5.6 usage estimates include cache writes when the upstream response reports them.
- Added `Ctrl+Alt+N` as a global floating-window recall shortcut and made startup and explicit show actions raise the window to the foreground.
- Unified main-window and tray floating-window show/hide state, while keeping the existing optional always-on-top pin.
- Removed redundant approximation symbols from Token estimates in summary, list, and card views.
- Matched API quota typography to the Navo interface and reduced the vertical height of the local-usage panel.

## 1.2.81

- Isolated Codex scheduled-task definitions and run history between normal accounts and each Navo API Key while continuing to share projects and conversations.
- Added transactional automation-scope backup and restore, plus quarantine for identifiable API tasks leaked by earlier releases.
- Added floating-window cache rate and a live quota refresh button.
- Fixed invisible notification-channel checkboxes expanding the page and creating a full-width horizontal scrollbar.
- Migrated the legacy notification variable string to the plain default message `有任务已处理完毕。` while preserving exact user-authored messages.

## 1.2.80

- Changed floating-window Token values to unambiguous K, M, and B units instead of locale-dependent compact suffixes.
- Changed the Windows tray menu to switch live between Show Floating Window and Hide Floating Window.
- Added a persisted pin button that toggles whether the floating window stays above other windows.

## 1.2.79

- Added a compact always-on-top floating window with current account quota, account usage, active task activity, and per-task usage.
- Added glass, midnight, and paper floating-window themes, adjustable opacity, a draggable header, and persisted position and visibility.
- Matched the floating window to the Navo locale and added a main-window and tray entry for restoring it.
- Simplified local and account usage labels to input, cache rate, and output.
- Removed notification message presets and template expansion so external channels send the user's saved text exactly as entered.

## 1.2.78

- Fixed the viewport-pinned sidebar taking the main page out of its intended grid column on desktop widths.
- Restored full-width account, usage, and feature content while keeping the sidebar independently fixed.
- Added a responsive regression check that returns main content to the first column on compact layouts.

## 1.2.77

- Added one-click cleanup for failed or interrupted conversations, with list-only hiding and explicit local Codex data deletion modes.
- Matched session and launch-chooser names to the Codex Desktop session index and custom project catalog.
- Made all-session project groups start collapsed and pinned the desktop navigation sidebar to the viewport.
- Corrected historical API usage cost migration, clarified that input includes cached Tokens, and kept cache hit rate as a percentage.

## 1.2.76

- Aligned the notification template and alert-control rows to the same equal-width two-column grid.
- Redesigned sound and volume controls as balanced cards with a live volume percentage.
- Restored cache hit rate as a percentage of cached input Tokens over total input Tokens.

## 1.2.75

- Added API gateway Token cost estimation, including a one-time estimate for existing usage, and changed cache reporting to the number of cache-hit Tokens.
- Reworked the launch chooser so project cards keep their height and scroll cleanly without compressed rows.
- Replaced the static imported-audio entry with named local sounds and added editable built-in templates for external notification channels.
- Aligned session management with the Codex SQLite conversation catalog, separated current and archived conversations by project, and added persistent project folding plus failed, archive, and delete actions.
- Removed the session catalog's system-Python dependency and added rollback-safe archive and delete operations.

## 1.2.74

- Added launch-selection progress and a clearer project/session scrolling track.
- Included Navo API gateway Token and request usage in the local usage dashboard.
- Rebuilt session management as nested project cards with conversation timelines and removed the monitor status banner.
- Expanded dynamic English localization, localized reasoning levels, removed preset network and wake prompt text, and stretched language settings to the full content width.
- Added compact independent folding controls for API Codex and regular account groups.

## 1.2.73

- Removed the optional account-management placement field: every Navo API Key now has an account card automatically.
- Added a dedicated proxy route for each Navo API account pool without changing regular account routes.
- Reworked Navo API card-mode spacing and action layout.
- Removed the redundant launch-language hint and pinned the launch actions below a scrollable project list.

## 1.2.72

- Matched the session heading typography to other feature pages and simplified the language settings layout.
- Replaced placeholder API actions with consistent network and wake SVG icons.
- Added eight CC0 Kenney notification sounds and retained local audio import.
- Added SSE usage tracking so streaming API Codex requests record input, cached, output, and reasoning tokens.

## 1.2.71

- Redesigned language settings as a compact system-style preferences page with a focused picker, current status, Windows detection, and Codex synchronization cards.

## 1.2.70

- Completed English fallback translation for static, dynamic, and accessibility UI text.
- Changed Navo API quota progress to the average of the total remaining quota across every linked account, including zero-quota accounts.

## 1.2.69

- Matured Navo API account cards with real key/account-pool quota progress, usage expansion, account routing, wake, refresh, and Codex launch controls.
- Added project-grouped collapsible session management, a sticky compact header, and a smaller redesigned Codex launch chooser.
- Added the installed Codex Desktop locale catalog and linked the app preference, Windows locale, and Codex launch default.
- Expanded notification sounds, added local audio import, and kept message templates ready for Feishu, DingTalk, and Telegram tests.

## 1.2.68

- Fixed Simplified Chinese launches still showing the English Codex interface. Navo now activates the translation layer already bundled with Codex Desktop after applying `localeOverride`.
- The launch-scoped locale bridge binds only to loopback, is skipped for English, and does not modify the installed Codex package.

## 1.2.67

- Raise the local Responses and Chat Completions request-body limit from 2 MB to 64 MB so resumed history conversations reach the account-pool forwarder instead of failing locally with HTTP 413.
- Pass the selected locale to the Codex Electron process explicitly while retaining the effective `[desktop].localeOverride` setting used by current Codex releases.
- Reduce the launch chooser to a 700 px width and 84% viewport height, with tighter project rows, list height, spacing, and actions.
- Add an integration regression that sends a request larger than 3 MB through the local gateway and verifies it is not rejected as payload too large.

## 1.2.66

- Collapse projects by default in the Codex launch chooser, with per-project toggles, expand/collapse-all controls, live selected counts, and a one-click “only this project” action.
- Filter both the desktop catalog and the primary thread state for each launch so unselected conversations no longer leak into Recents; merge selected and newly created thread metadata back when Codex exits.
- Fix API conversations failing to resume on current Codex releases by using the valid `codex_navo` custom provider instead of overriding the reserved built-in `openai` provider ID.
- Make launch-state restoration independent for global state, thread state, catalog, and config, retaining recovery backups if any restoration step reports an error.

## 1.2.65

- Add one launch chooser for both managed-account and Navo API Codex modes, with language, project, conversation, per-project, and select-all controls.
- Load only the selected project and conversation catalog for the current launch, then restore the complete original desktop state after Codex exits.
- Add optional backed-up cleanup for oversized rollout files that contain repeated compaction snapshots, reducing startup and conversation hydration overhead without deleting the original backup.
- Apply the selected Simplified Chinese or English desktop locale consistently to normal-account and API launches.

## 1.2.64

- Fix API Codex opening the ChatGPT sign-in screen when the shared Codex home has no active `auth.json`. API launches now install a temporary API-key login state and restore the original file byte-for-byte on exit.
- Keep the API launch transaction attached when the Microsoft Store Codex app replaces its root process shortly after startup, preventing premature config/auth restoration under a live window.
- Retain the built-in `openai` provider identity so existing projects and conversations remain visible while requests are routed through the local Navo gateway.

## 1.2.63

- 修复 API Codex 已复用中文界面和本机项目、但历史聊天仍不显示的问题。
- API 模式继续使用 `openai` 线程身份，仅临时覆盖其传输地址为 Navo 本地网关，避免 Codex Desktop 按 provider 隔离历史会话。
- 保持共享数据库和会话文件原样，不复制、不批量改写历史线程；API 退出后仍按原始字节恢复配置。

## 1.2.62

- 修复 Windows 终端和 PowerShell 子进程可能用错误代码页显示中文、产生乱码的问题；后台终端日志改用英文，应用界面继续保持中文。
- 新增 UTF-8 编码检查和编辑器规则，构建与测试会阻止无效 UTF-8、BOM、替换字符及典型乱码进入安装包。
- Codex 进程归属改用 PID、父 PID、创建时间、可执行路径和命令行摘要，避免把直接启动或 PID 复用的 Codex 识别为 Navo 管理实例。
- API Codex 共享配置切换增加跨进程锁、所有权校验和异常恢复，退出后按原始字节恢复配置。

## 1.2.61

- 修复 API Codex 仍在运行时因 Windows 商店版进程短暂替换而被误判退出，导致活动标记提前删除、实例被显示为“外部 Codex”的问题。
- API Codex 生命周期优先跟踪本次启动记录的真实 PID，并为进程替换增加宽限期；一次 WMI 空结果不再立即恢复配置。
- API Codex 不再替换共享 `auth.json`，本地网关鉴权只通过本次启动进程的环境变量传入，保留正常 Codex 身份及原有项目和会话。

## 1.2.60

- 修复 API Codex 启动预热期间被状态轮询误判为“已经退出”，导致临时网关配置提前恢复、桌面端仍进入空白会话环境的问题。
- API Codex 启动事务新增 preparing、launching、running 三阶段状态；配置写入失败、桌面启动失败和正常退出都会可靠恢复原始配置与登录凭证。
- 新增独立的 API Codex 生命周期监控，退出后的恢复不再依赖用户停留在 API 服务页面或触发前端刷新。

## 1.2.59

- 修复 Codex Navo API 启动后看得到本机项目、却读不到原有会话的问题。
- API Codex 运行时直接复用正常 Codex 的项目、会话、语言与桌面状态，仅临时切换本地网关配置和凭证；退出、启动失败或异常中断后自动恢复原配置。
- 移除失效的隔离运行目录与根级 SQLite 拼接方案，避免再次生成分叉的项目和会话索引。

## 1.2.57

- 账号代理改为固定本地入口与 Mihomo 控制器热切换，Codex 和独立 Chrome 正在运行时也可更换节点或切回直连，无需重启应用。
- 账号代理核心预载全部线路来源；跨订阅切换保持原端口，新增线路后会原地重载配置，切换失败自动恢复原线路。
- 修复运行中账号被服务端禁止保存线路、网络错误后“保存线路”不可用的问题。
- 修复 Codex Navo API 独立运行环境未复用本机 SQLite、会话和项目状态，导致英文首次引导、项目丢失及普通账号设置被污染的问题。
- 启动 API Codex 前仅补回被旧版本误删的已知配置项，并自动保留恢复前备份，不覆盖用户当前设置。

## 1.2.56

- 修复 Codex Navo API 启动后污染普通账号配置、引发初始化界面和主题变化的问题。
- API Codex 改用隔离配置目录，同时复用本机共享会话数据库；普通账号的 `~/.codex/config.toml` 不再被临时 API 配置覆盖。
- 修复 Store 版 Codex 启动进程替换后被误判为退出的问题，并在显式退出 API Codex 时完整结束进程树。
- Codex Navo API 账号卡片改为普通账号卡片布局，补齐今日用量，并简化 API 账号排序界面。

## 1.2.55

- 修复从“账号管理”启动 Codex Navo API 时进入首次使用引导的问题。
- API Codex 改为继承本机 Codex 的初始化状态、语言、项目和会话，只在运行期间临时切换网关配置与凭证。
- API Codex 退出、启动失败或异常中断后自动恢复原始 Codex 配置与登录凭证。

## 1.2.54

- 修复缺少结束事件的旧会话永久显示“运行中”的问题：运行日志超过 15 分钟没有任何文件活动后会自动归入历史会话。
- Navo API Key 新增反代账号选择与顺序配置，只使用勾选账号，并在额度耗尽、授权失效、限流或上游失败时按顺序切换。
- 修复移除外部供应商后反代请求仍调用旧 `resolveProvider` 链路的问题，`/v1/responses` 与 `/v1/chat/completions` 现在直接进入账号池转发。
- 创建或编辑 Navo API Key 时可选择添加到“账号管理”；虚拟卡片显示请求与 Token 用量、账号顺序及对应代理线路，并可启动独立的 Codex Navo API 运行入口。
- Codex Navo API 桌面入口使用每次启动临时签发的本机凭证，完整 Navo Key 仍不会写入公开状态或账号卡片。

## 1.2.53

- 会话管理接入 Codex 本机实时会话：增量读取 `~/.codex/sessions` 与会话索引，展示运行中、等待处理、完成、失败和历史会话。
- 新增独立的“通知提醒”侧边栏，支持 Windows 通知、两种本机提示音，以及飞书、钉钉和 Telegram 机器人。
- 会话监控采用文件尾部读取与增量偏移，避免启动时全量加载大型 JSONL；任务完成、失败、等待输入或授权时可即时提醒。
- 为后续无感切号保存本机会话检查点信息，包括项目目录、会话 ID、任务状态、最近回复和 Token 用量。

## 1.2.52

- 修复 API Key 页面中文被错误写成问号的问题，恢复权限、额度、模型检测和空状态文案。
- Navo 后台服务不再继承 Windows 用户级代理环境变量；直连账号不会误走已经失效的 `127.0.0.1:7897`。
- 反代 API 固定使用 `127.0.0.1:8318`，端口冲突时明确报错，不再自动跳到其他端口。
- 每账号 Mihomo 仍使用 Windows 分配的独立空闲端口，与 Clash 的固定监听端口隔离。

## 1.2.51

- API 服务收敛为 Codex Navo 账号池反代，只保留账号池模型与 Navo API Key 管理。
- 移除外部模型供应商的界面、接口、凭据读取、Codex 启动配置和协议转换代码。
- 移除皮肤管理页面、主题资源、Codex 界面注入与调试端口逻辑。
- 旧 Navo API Key 启动时自动迁移到账号池，外部模型权限会被清理。

## 1.2.50

- 将 Codex Navo 账号池从“模型供应商”管理列表中移除。账号池仅作为 Navo API Key 的内置模型来源，不再和 DeepSeek 等外部供应商混排，也不再显示供应商启动按钮。
- “模型供应商”调整为“外部模型供应商”，这里只管理用户主动接入的 DeepSeek 或其他兼容 API 服务。

## 1.2.49

- 调整模型供应商弹窗：API Key 移到模型选择之前，填写连接信息后再检测模型，操作顺序更清晰。
- Base URL、API Key 和模型输入统一为全宽控件；模型改为紧凑单行输入，不再占用大块纵向空间。
- 模型供应商与 Navo API Key 从拥挤的左右双栏改为上下整行布局，供应商模型、状态和操作按钮恢复横向展示。
- 修复创建 Navo API Key 时误把外部 DeepSeek 当作默认模型来源的问题：账号池现在是常驻的内置供应商，新 Key 默认仅使用已绑定的 GPT / Codex 账号；外部供应商需要明确勾选后才会加入权限。
- Key 权限中的供应商 UUID 输入框改为可读的模型来源选择卡，账号池模型与外部供应商模型分开检测和授权。

## 1.2.48

- 外部模型供应商新增“一键交接”启动：当前 Codex 正在运行时，由 Navo 自动保存并结束当前实例，再以所选供应商和模型启动新的 Codex。
- 外部模型 Codex 延续本机 `.codex` 中的项目、会话索引和工作目录，不再要求用户手动退出后重新打开。
- 供应商按钮改为“用此模型打开”，明确其会切换当前 Codex 的模型运行入口。

## 1.2.47

- API 服务页移除“本地 API 网关”和“在 Codex 中使用”两张说明卡，顶部改为紧凑的 API 文档，展示 Base URL、鉴权格式、三项接口和可复制请求示例。
- 模型供应商与 Navo API Key 改为双栏管理布局，小屏自动恢复单栏。
- 添加供应商时可选择 OpenAI、DeepSeek、Gemini、xAI、Groq、Mistral、Qwen、Moonshot、智谱、SiliconFlow、OpenRouter 等厂商，并自动填写对应 Base URL 与兼容协议。
- 新增供应商模型检测与勾选：使用当前 Base URL 和 API Key 实时读取 `/models`；Navo API Key 权限也可按供应商重新检测并选择允许的模型。
- 修复本机其他 API 程序占用 `127.0.0.1:8317` 时，请求误入其他服务并提示 Key 无效的问题；Codex Navo 启动时会检测冲突、自动选择空闲端口并在文档中显示真实地址。

## 1.2.46

- 修复 API 服务页面点击“添加供应商”“创建 Key”时报 `prompt() is not supported` 的问题。
- 供应商配置、API Key 权限和删除确认全部改为 Codex Navo 内置弹窗，支持取消、Esc 关闭、字段校验和响应式布局。

## 1.2.45

- 新增 API 服务：支持 DeepSeek、OpenAI Responses 兼容供应商和 Codex 账号池供应商，生成 OpenAI Bearer 格式的 Navo API Key。
- 新增 `/v1/models`、`/v1/responses`、`/v1/chat/completions`，兼容普通与流式输出、工具调用和供应商限定模型名。
- 账号池供应商按剩余额度与最近使用情况择优路由，支持 OAuth 自动刷新以及限流、授权和上游故障切换。
- 支持从供应商直接启动绑定模型的 Codex，退出时恢复用户原有配置。
- 新增 Key 的供应商/模型权限、请求额度、Token 额度和到期时间，并支持局域网监听配置。

## 1.2.44

- 主题图库默认只保留“Codex 官方外观”，移除“Navo 极光”和“柔光纸页”两套内置主题。
- 首次升级会清理旧版生成的同名主题副本，并将默认主题和账号主题映射恢复为官方外观。

## 1.2.43

- 修复图片主题把 Codex 整个中央工作区误识别为普通面板的问题；移除对 `panel`、`card`、`content` 等模糊类名的全局匹配，改为只渲染明确的弹窗、菜单、卡片和输入控件。
- 修复背景安全区域为“自动”时仍叠加 38% 白色渐变蒙层的问题；自动模式不再覆盖背景图，仅在明确选择左侧或右侧安全区域时增加渐变。

## 1.2.42

- 修复图片主题虽然完成取色、但继承官方主题的 0% 背景强度而看不到图片的问题；选择图片后会自动提取主色、强调色和文字色，并设置可见的首页与任务页背景强度。
- 自动迁移旧版本创建的“图片存在但背景强度为 0%”主题，无需重新选择图片。
- 修复“应用到当前 Codex”只保存主题映射、没有真正注入运行中 Codex 的问题；当前进程缺少主题连接时会重启同一账号的 Codex，完成注入验证后才显示成功，失败会直接显示原因。

## 1.2.41

- 修复主题图库组件与样式类名不一致导致的原生按钮、卡片散开和导入按钮竖排问题，重新统一三列卡片、预览区域、标题与操作区布局。
- 在线主题包拉取与应用更新检查、下载统一复用额度刷新和账号唤醒的后台择优代理：优先使用正在运行账号的可用节点，否则选择已配置节点中延迟最低的线路，没有可用节点时直连。

## 1.2.40

- 皮肤管理从占位页升级为官方 Codex 桌面端主题工作台：支持图片背景、实时首页/任务页预览、自动配色、明暗模式、背景构图、透明度、圆角和字体调整。
- 主题通过 Codex 启动时的本机 CDP 通道注入，不修改 WindowsApps 或官方安装文件；应用后验证页面标记，失败时恢复上一个已验证主题。
- 新增内置主题、本地主题保存、默认主题切换、账号独立主题、ZIP 导入导出及 HTTPS 社区主题包导入。
- 主题包导入增加平台、版本、文件数量、解压大小、SHA-256、图片格式与 Safe CSS 校验；主题图片仅在本机运行时读取。

## 1.2.39

- 账号独立线路现在明确覆盖 Codex 内的 GitHub 访问；Chrome 网络层、Codex 子进程及 Git 命令统一继承该账号的代理节点，GitHub 不再受系统 `NO_PROXY` 绕过配置影响。

## 1.2.38

- 修复官方授权成功后只保存 Codex 凭证、独立 Chrome 未确认 ChatGPT 网页会话的问题；授权结束后会在同一账号窗口验证网页登录并返回 `chatgpt.com`，同时离开外部协议提示页。
- 右上角版本号恢复为应用内更新弹窗，不再进入已移除的空白更新页面。
- 阻止后台状态与额度刷新在输入框、下拉框或弹窗操作期间重绘界面，修复偶发无法输入、无法选择和焦点丢失。
- 收紧侧边栏独立页面的标题区高度与留白，并统一网络代理图标和线路下拉框字体。

## 1.2.37

- 优化账号添加与账号卡片交互：授权包导入直接显示，账号用量默认收起并可点击卡片展开。
- 调整网络入口图标与页面字体，使其与 Codex Navo 现有主题保持一致。
- 恢复页面右上角版本号与应用更新入口。
- 修复新增代理账号过程中后台线路重启后，已运行 Codex 因本地代理端口失效而断线的问题；现在会自动恢复当前账号的代理运行实例。
- 账号代理现在覆盖 GitHub 等全部远程地址，仅绕过本机 IPC 与回环地址，避免系统 `NO_PROXY` 配置让 GitHub 意外直连。

## 1.2.36

- 修复独立 Chrome 使用 `--remote-debugging-port=0` 时暴露自动化标记，导致 OpenAI 登录接口返回 Cloudflare HTML/403、页面出现 `Unexpected token '<'` 的问题。
- 改为为每个账号分配固定的随机本机调试端口，在保留窗口状态检测能力的同时保持普通 Chrome 浏览器特征。

## 1.2.35

- 修复切换账号节点时重启 Mihomo 并随机更换本地端口，导致已运行的 Chrome 与 Codex 持续重连的问题；同一线路内改节点现在通过控制接口热切换并保持端口不变。
- 修复授权诊断器把 OpenAI 遥测请求的 HTML/403 响应误判为整个登录失败的问题；诊断监听改为默认关闭，授权结果以官方 Codex 登录服务为准。
- 重新授权时保留独立 Chrome 的 Cookie、本地存储和人机验证状态，不再删除整个浏览器配置目录。
- 登录链路只执行一次必要的代理预检，避免在打开 Chrome 前重复请求认证端点。

## 1.2.34

- 修复关闭登录 Chrome 后账号仍长期处于授权占用状态的问题。
- 捕获官方登录接口被代理节点返回 HTML/Cloudflare 验证页的真实错误，并自动释放失败任务。
- 重新授权未完成账号时重建独立 Chrome 登录环境，避免失败挑战状态反复触发人机验证。
- 自动清理已删除账号遗留的无效租约。

## 1.2.33

- 修复代理节点只通过 ChatGPT 首页检测、但填写邮箱后仍出现 `Unexpected token '<'` 的问题：检测范围新增 OpenAI 账号认证 API。
- 单节点检测、批量检测、添加账号和 Codex OAuth 现在使用同一套完整认证链路标准，不再把“首页可达、认证接口被 Cloudflare 拒绝”的节点标记为可用。
- Codex 返回真实 OAuth 地址后会在打开独立 Chrome 前再次验证线路，节点状态在登录过程中变化时会直接显示具体原因。

## 1.2.32

- 代理账号在打开登录页和启动 Codex 前会完整检查 ChatGPT 首页、登录 JSON 接口与 OpenAI OAuth 页面；Cloudflare 403、地区限制、HTML 错页和连接失败会被明确区分。
- 修复代理返回 HTML 时登录页面出现 `Unexpected token '<'` 的问题；不合格节点会在打开浏览器前被拦截并显示具体原因。
- 账号代理核心增加并发启动锁和运行代次校验；添加、取消或重试其他账号时，不再替换正在使用账号的代理实例。
- 添加账号移除后台交互登录，只保留官方浏览器登录和 `.codexnavo` 授权包导入。
- 节点检测结果增加检测时间，登录预检会及时刷新过期的“可用”状态。

## 1.2.31

- 添加账号时可直接选择直连或已有代理节点；所选线路会在首次网页登录和 Codex OAuth 启动前生效。

## 1.2.30

- 修复账号配置代理后 Codex Desktop 持续重连：Chromium 页面层与后台实时连接现在统一使用该账号的本地代理线路，并保留本机 IPC 绕过。

## 1.2.29

- 修复配置代理后 Codex 桌面端反复重连的问题：桌面端改为只注入 HTTP(S) 代理环境，不再使用会影响 Electron 本地连接的 Chromium 代理启动参数。
- 额度刷新、账号唤醒和授权健康检查统一使用共享后台线路：优先使用当前运行账号的可用代理，否则自动选择已配置的最低延迟可用节点。
- 修复账号网络弹窗已选择节点后仍显示“还没有可用节点”的错误提示。
- 优化网络代理添加区和唤醒设置页布局，并从侧边栏移除应用更新板块。

## 1.2.28

- 修复 Microsoft Store 版 Codex 启动时更换引导进程，导致 Navo 过早恢复凭证并打开默认未登录账号的问题。
- 账号代理同时传递给 Codex 的 Chromium 与 Node 网络层，并明确绕过本机回环连接，避免代理账号卡在启动画面。
- 重做网络代理、授权迁移、唤醒设置和应用更新的独立页面，不再沿用弹窗式布局。
- 应用更新页始终显示 Codex Navo 与 Codex 的已安装版本；重新检测不再自动跳转商店，更新入口单独展示。

## 1.2.27

- 修复账号独立代理可能让 Codex 桌面端卡在启动画面的问题：收窄代理环境变量、明确绕过本机回环连接，并在启动前验证所选节点可用性。
- 侧边栏全部改为真正的应用内独立页面，网络代理、授权迁移和唤醒设置不再使用弹窗。
- “应用设置”更名为“应用更新”，分别展示 Codex Navo 与 Codex 桌面端的已安装版本和更新入口。

## 1.2.26

- 侧边栏扩展为账号管理、网络代理、授权迁移、皮肤管理、会话管理、反代配置、唤醒设置和应用设置八个入口。
- 为皮肤管理、会话管理和反代配置建立独立空白占位页面，便于后续逐步补充功能。
- 移除网络代理右侧状态点，侧边栏的图标与文字统一改为居中排列。

## 1.2.25

- 新增可折叠侧边栏，集中收纳账号管理、网络代理、授权迁移、唤醒设置和应用设置五个一级入口。
- 清理账号池顶部的网络、授权和唤醒设置按钮，仅保留账号管理中的高频操作。
- 一键唤醒全部移动到唤醒设置面板；侧边栏折叠状态会在本机记忆，并适配小窗口布局。

## 1.2.24

- 重绘全局与账号级网络线路图标，移除容易被误认为“分享”的三点连线造型，并统一为简洁的路由线路样式。
- 未配置代理时使用中性按钮，只有账号已使用代理时才显示轻量状态色。

## 1.2.23

- 将线路名称、节点或订阅和添加按钮统一为单行、同高度布局，添加操作改为轻量按钮。
- 节点列表按照检测状态与延迟升序排列：低延迟可用节点优先，失败和未检测节点后置。
- 账号线路选择同步使用延迟排序，并为每个节点显示延迟、地区限制或连接失败状态。

## 1.2.22

- 节点来源新增“检测全部”，使用有限并发检测整条线路中的所有节点，并汇总可用、地区不支持和失败数量。
- 修正检测失败节点被错误显示为“0 ms · 已检测”的状态转换问题。
- 重新对齐线路名称、订阅输入框和添加按钮，统一字段标题、控件顶边与间距。

## 1.2.21

- 将 Mihomo v1.19.29 官方核心内置到安装包，首次添加节点不再依赖运行时访问 GitHub；核心随 Codex Navo 版本更新并执行 SHA-256 校验。
- 重做节点与订阅界面，改为左侧线路来源、右侧节点列表的双栏布局，压缩添加区域并清理多层边框和无效空白。
- 完善单账号线路设置：没有可用节点时直接提示原因并提供“管理节点”入口，保存与失败结果在当前弹窗内显示。
- 修复订阅核心准备失败时只显示 `fetch failed`、用户难以判断失败阶段的问题。

## 1.2.20

- 将原有全局代理升级为账号级网络配置，每个账号可分别选择直连或不同代理节点。
- 新增节点与订阅管理，支持自动识别 HTTP、HTTPS、SOCKS5、SS、SSR、VMess、VLESS、Trojan、Hysteria、Hysteria2、TUIC、WireGuard、Base64 节点列表和 Clash 配置。
- 新增机场订阅读取与刷新、订阅节点选择以及单节点延迟检测。
- 节点检测改为真实访问 ChatGPT，并区分正常可用、地区不受支持、站点拒绝、访问限流和连接失败。
- 账号代理同时应用于独立 Chrome、网页登录、Codex OAuth、额度刷新、账号唤醒和 Codex 桌面端。
- 重做顶部网络入口和账号卡片线路按钮，移除原有醒目的 VPN 文字按钮。

## 1.2.19

- 新增 Codex 连接代理入口，可配置 HTTP、HTTPS 和 SOCKS5 代理及可选账号认证。
- 新增代理连通性检测；保存的密码不回显，也不会返回到前端页面。
- 从 Codex Navo 启动的 Codex 桌面端、登录授权、额度刷新和账号唤醒会统一继承代理环境变量。

## 1.2.18

- 移除任务进展、历史会话看板和 Codex Hooks 监控。
- 移除 Windows、飞书、钉钉、企业微信和 Webhook 消息提醒及相关设置。
- 账号池恢复为单一主界面，并在启动时清理旧版 Codex Navo Hook 配置。

## 1.2.17

- 修复任务进展只依赖 Hooks、导致 Codex 正在运行的任务显示为 0 的问题；现在会结合本机 rollout 实时活动判断运行与完成状态。
- 任务进展改为接近 Codex 的“项目 → 会话”布局，可在左侧项目树中切换项目并定位对应会话。
- 历史会话继续保留在所选项目中，运行任务优先显示，项目和会话状态更加直观。

## 1.2.16

- 新增 Codex 历史会话自动索引，首次打开任务进展页即可读取本机已有会话。
- 历史会话与实时 Hooks 状态分开显示，旧任务不会被误判为正在运行，也不会触发集中通知。
- 新增“同步历史会话”入口，支持按 Codex 本地数据库变化增量更新和手动重新扫描。

## 1.2.15

- 新增任务进展看板，集中展示 Codex 任务的运行、等待授权、完成和失败状态。
- 接入 Codex 官方 Hooks，任务事件在本机归并，并补充项目、运行时长、Token 与 Goal 进度。
- 新增 Windows 桌面、飞书、钉钉、企业微信和通用 Webhook 消息提醒，支持事件选择、完成时长阈值与测试消息。

## 1.2.14

- 修复 Windows WMI/CIM 偶发超时导致整个账号池显示“无法读取本地状态”的问题。
- Codex 运行状态检测增加快速备用查询、短时缓存和最近一次状态降级；单次检测失败不再阻断账号列表加载，也不会误清理当前授权状态。

## 1.2.13

- 强化 README 标题与首段的中英文搜索关键词，明确说明 Codex 多账号管理、账号切换、额度和独立 Chrome 环境。
- 优化项目描述并补充 GitHub Topics，提升仓库在 GitHub 和搜索引擎中的可发现性。

## 1.2.12

- 移除应用图标右下角的蓝色圆点，保留原有透明背景、深蓝圆角底和白色斜线主体。

## 1.2.11

- 重写 README，优先用简单语言说明 Codex Navo 的用途、核心功能和三步使用流程。
- 新增覆盖账号池、列表视图、添加账号、更多登录方式、账号唤醒及授权迁移的完整功能截图。
- 所有公开展示截图使用演示邮箱替换真实账号信息。

## 1.2.10

- 添加账号默认只突出显示推荐的“登录并授权”，继续使用稳定的官方浏览器 OAuth。
- 后台协议流程改名为“后台交互登录”，与导入授权包一起收纳到“更多登录方式”。
- 后台交互登录失败时新增“改用官方登录”，可直接切换到官方浏览器流程继续授权。

## 1.2.9

- 协议登录不再在手机号验证阶段生成临时 Codex 凭证，也不再跳过官方验证流程。
- 手机号、短信验证码、邮箱验证码和 2FA 继续在应用内交互；完成真实 Codex OAuth 并取得可刷新凭证后才会入池。
- 移除临时授权的手动续期按钮和自动续期任务；旧版临时凭证会提示重新完成官方授权。

## 1.2.8

- 改进协议登录的网页会话写入与 Codex 授权状态检查。
- 优化手机号验证阶段的交互反馈和错误展示。
- 补充协议登录与授权兼容性测试。

## 1.2.7

- 协议登录遇到官方手机号绑定时，不再停留在手机号输入步骤；应用会保存独立 Chrome 网页会话、生成临时 Codex 凭证并直接完成入池。
- “续期”改为直接读取对应账号的独立 Chrome 网页会话并重建临时凭证，不再重新执行会进入手机号绑定的官方 OAuth 流程。
- 临时凭证现在可被账号池、健康检查和 `.codexnavo` 授权包正确识别，同时继续显示到期时间和临时授权状态。
- 添加账号弹窗明确区分“官方浏览器登录”和“协议登录（临时授权）”。

## 1.2.6

- 临时 Codex 授权新增明确的到期时间显示，并按 JWT `exp` 标记正常、即将到期或已经到期。
- 账号卡片新增“续期”按钮，重新执行官方 Codex OAuth；取得真实可刷新凭证并验证成功后才替换原授权。
- 临时授权距离到期不足 24 小时或已经被官方拒绝刷新时，会自动发起一次续期任务；同一账号 24 小时内最多自动尝试一次。
- 续期遇到邮箱验证码、2FA、手机号或短信验证时，继续使用账号卡片中的现有输入流程，不覆盖旧凭证。

## 1.2.5

- 修复协议登录手机号绑定场景把 ChatGPT 网页访问凭证误当作可刷新 Codex OAuth 凭证，导致 Codex 桌面端提示 access token 无法刷新的问题。
- 网页端登录会继续保留，但账号保持“Codex 授权未完成”；完成官方 OAuth 与服务端要求的验证后才会启用 Codex 桌面端。
- 自动识别并归档旧版不可刷新的临时 `auth.json`，避免再次传给 Codex；账号独立 Chrome 中的网页会话不受影响。
- 修复手机号验证后协议流程可能复用已关闭 Chrome 调试通道的问题。

## 1.2.4

- “添加账号”弹窗新增“导入授权包”，可直接选择 `.codexnavo` 文件创建账号并恢复 Codex 授权与可用网页会话。
- 授权包选择、大小检查和读取逻辑在添加账号入口与授权工具之间复用，旧版 Codex 单端包继续兼容。

## 1.2.3

- 单账号授权检查新增“检查中”状态、加载动画和针对该账号的检查结果。
- 授权检查完成提示新增关闭按钮，成功提示会在 5 秒后自动消失，错误提示保留到手动关闭。

## 1.2.2

- `.codexnavo` 授权包新增可选的 `web-session.json`，可在同一文件中携带 Codex 授权与 ChatGPT 网页会话。
- 导出时从账号独立 Chrome 提取并标准化 ChatGPT/OpenAI Cookie，不包含历史记录、项目、缓存或其他网站数据。
- 导入时先验证并写入 Codex 授权，再向新建的独立 Chrome 环境写入网页会话并进行在线校验与落盘复检。
- 网页会话失效时保留已成功导入的 Codex 授权，并在界面中分别显示双端导入结果。
- 继续兼容此前仅包含 `auth.json` 的 `.codexnavo` 授权包。

## 1.2.1

- 协议登录完成并入池后不再自动打开账号独立 Chrome；需要时由用户点击“网页端”打开。
- 手动打开网页端仍会校验并绑定该账号的独立 Chrome 数据目录。
- 修正更新安装 Codex Navo 时可能同时关闭 Codex 桌面端的问题：退出与安装清理不再递归终止 Navo 的子进程树。

## 1.2.0

- 修正协议登录完成后网页端可能被普通 Chrome 接管、没有进入对应账号独立窗口的问题。
- 账号 Chrome 统一显式绑定独立 `user-data-dir` 和 `Default` 配置目录，并通过专属调试通道确认实际启动目录。
- 协议登录完成后会关闭临时后台 Chrome，再打开该账号已经写入登录会话的可见独立窗口。
- 独立窗口自动进入浏览器占用状态，关闭窗口后再按原有规则释放账号。

## 1.1.65

- 修正协议登录临时 Codex 校验目录被子进程短暂占用时触发 `EPERM`、错误回退到手机号验证的问题。
- Codex 额度校验会等待子进程退出；临时凭证目录采用唯一名称并通过重试机制延迟清理，清理失败不再影响账号入池。
- 登录方式名称调整为“协议登录（免接码）”，移除说明提示条。
- 从授权工具中移除邮箱接口检测区域及对应接口。

## 1.1.64

- 修正协议登录最终校验异常时可能导致本地服务退出、账号池随后显示 `Failed to fetch` 的问题。
- 后台服务进程退出后由桌面主进程自动重启，并将运行错误记录到本机 `server.log`。
- 应用重启后会把遗留的 `finalizing` 授权任务恢复为“已中断”，不再永久卡在验证中。
- 登录弹窗内直接显示后台连接错误；弹窗背景取消磨砂模糊，保留轻微遮罩。

## 1.1.63

- 修正协议登录遇到手机号绑定时先显示手机号输入框、随后其实已经完成 Codex 授权的状态误判。
- 网页凭证回退现在会在独立 Chrome 完整关闭并重新打开后再次校验会话，确认网页登录确实持久化后才将账号标记为已入池。
- Chrome 通过调试协议关闭时等待正常退出，避免立即强制结束导致 Cookie 尚未落盘。

## 1.1.62

### 新增

- 协议登录遇到 Codex 手机号绑定步骤时，自动参考 `codex-auth-helper` 的网页会话导入思路，从该账号独立 Chrome 获取当前网页访问凭证，生成临时 Codex `auth.json`，并在写入账号池前通过 Codex 额度接口在线验证。
- 协议登录启动后保留添加账号弹窗；邮箱验证码、密码、2FA 及其他人工验证步骤统一在当前弹窗内完成，不再要求到账号卡片寻找输入框。

### 可靠性

- 网页凭证回退使用离屏可见 Chrome，避开 Headless 环境访问 ChatGPT 会话接口时可能出现的 403；导入失败时保留手机号人工验证流程。

## 1.1.61

### 修复

- 修复协议登录取得的 OAuth Token 缺少 Codex 官方 `api.connectors.read` 与 `api.connectors.invoke` scopes，导致授权完成后额度接口仍返回 401 的问题。
- 写入 `auth.json` 时以 OAuth JWT 中的账号 ID 为准，并补充官方认证文件使用的刷新时间字段。

## 1.1.60

### 修复

- 修复从 Windows 桌面启动时，协议登录子进程没有继承系统代理而出现 `fetch failed` 的问题。
- 协议登录优先使用已有代理环境变量；未配置时自动读取 Windows 当前用户的系统代理，并传递给隐藏登录进程。

## 1.1.59

### 调整

- 添加账号只保留“官方浏览器登录”和“协议登录与授权”两种方式，移除 CDK 信息导入。
- 协议登录移除邮箱验证码提取链接与自动轮询；邮箱验证码改为账号卡片中的人工输入框。
- 协议登录需要密码、2FA、手机号或短信验证码时，会依次显示对应输入框和确认按钮。

## 1.1.58

### 修复

- CDK 兑换接口遇到瞬时网络错误、限流或服务端临时错误时自动重试三次，降低偶发“CDK 信息读取失败”。
- 连续三次读取失败时在添加账号弹窗中明确显示重试次数，方便区分网络故障与兑换码错误。

## 1.1.57

### 新增

- 添加“CDK 信息导入”登录方式：输入兑换链接和 CDK 后读取并展示完整账号信息，确认后可把其中的 Codex OAuth 授权直接导入独立账号环境。
- CDK 读取结果使用一次性、十分钟有效的本机内存令牌传递；CDK、返回的账号信息和 OAuth 凭证不会写入应用日志。
- 实验性协议登录在完成 ChatGPT 网页会话后继续执行 Codex OAuth，手机号和短信验证码步骤会直接显示在对应账号卡片中。

### 调整

- 协议登录只有在网页会话与 Codex OAuth 都完成后才正式入池，并同时写入独立 Chrome 会话与独立 `auth.json`。

## 1.1.56

### 修复

- 公网邮箱接口识别到新验证码后改为自动提交，不再等待二次确认。
- 验证码接口轮询、读取与协议登录错误会直接显示在账号卡片中。
- Headless Chrome 网页会话校验增加三次重试；Cookie 已写入但 Headless 环境返回 HTTP 403 时，不再将整个登录流程判定为失败。
- 临时 Chrome 通过调试协议主动关闭后再执行进程清理，提升 Cookie 写盘可靠性。

## 1.1.55

### 调整

- 协议登录的临时 Chrome 改为 Headless 后台运行，不再在桌面弹出浏览器窗口。
- 登录成功、失败或取消时自动结束临时 Chrome 进程，释放独立账号目录。
- 账号入池后手动点击“网页端”仍按原方式打开可见的独立 Chrome。

## 1.1.54

### 修复

- 修复邮箱查看页面能够打开、但协议登录始终收不到验证码的问题。
- 按邮箱采集脚本的规则，将包含邮箱和鉴权参数的查看链接转换为同源 `mail-api` JSON 地址。
- 验证码等待阶段每 2.5 秒刷新接口，并在账号卡片显示轮询次数、候选数量和读取失败重试状态。
- 邮箱请求增加禁用缓存请求头，避免最新邮件接口返回旧响应。

## 1.1.53

### 调整

- 验证码提取链接支持本机接口与公网 HTTPS 接口，不再只接受本机回环地址。
- 公网接口读取到新验证码后增加一次应用内确认，确认后才提交给当前协议登录进程。
- 公网接口仍要求同源重定向与同源邮件数据接口，完整验证码和接口地址均不写入配置。

## 1.1.52

### 调整

- 将协议登录“快速识别”输入框移动到账号名称上方。
- 将验证码提取链接移动到邮箱提示下方，保留原有字段和自动识别行为。

## 1.1.51

### 新增

- 协议登录增加快速识别输入框，支持粘贴 `邮箱----验证码提取链接` 格式。
- 识别成功后自动以邮箱作为账号名称，并填写完整邮箱与提取链接。

## 1.1.50

### 修复

- 添加账号弹窗中的校验和接口错误改为直接显示在弹窗内部，不再被模态遮罩挡在下层。
- 验证码提取链接输入框不再显示预设 URL，改为明确提示用户自行粘贴链接。

## 1.1.49

### 新增

- 实验性协议登录可选连接本机 Mock 邮箱接口；进入邮箱验证码步骤后才开始轮询，并通过现有子进程输入通道自动提交新验证码。
- 启动登录前建立验证码基线，忽略接口中已经存在的旧码；自动读取失败或超时后保留人工输入。

### 范围

- 自动提交只接受 `127.0.0.1`、`localhost` 或 `::1` 回环接口，接口地址仅随当前创建请求短暂使用，不写入账号配置和日志。

## 1.1.48

### 新增

- 在“授权健康与迁移”中新增独立的邮箱接口检测工具，可检查公网接口的 HTTP 状态、响应格式、大小和脱敏结构。
- 接口地址只在当前检测请求中使用，不写入账号或应用配置。

### 范围

- 邮箱接口检测不读取邮件正文、主题、验证码或令牌，也不连接协议登录输入通道。

## 1.1.47

### 调整

- 实验性协议登录改为仅完成 ChatGPT 网页登录，网页会话验证成功后写入独立 Chrome 并入池。
- 协议流程在 Codex OAuth 前停止，不再进入后续 Codex 手机号绑定步骤。
- 网页端已入池但尚未授权 Codex 的账号会明确显示“Codex 待授权”。

## 1.1.46

### 新增

- 实验性协议登录改为后台静默运行，不再打开命令行窗口；需要人工验证时直接在账号卡片中显示输入框。
- 协议登录会同时完成独立 Chrome 网页会话和 Codex OAuth，网页端与桌面端验证都成功后才进入账号池。

### 改进

- 每个协议登录账号使用自己的 Chrome 用户目录，并通过仅监听本机回环地址的临时调试通道写入和验证网页会话。
- 登录临时文件在成功或失败后清理；验证码、密码、TOTP 和手机号不会写入配置或日志。

## 1.1.45

### 修复

- 协议登录进程现在会读取本机 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量，修复浏览器可以访问 ChatGPT、但协议登录首个请求连接超时的问题。
- 协议登录网络错误会显示失败请求、底层错误代码与连接原因，不再只显示笼统的 `fetch failed`。

## 1.1.44

### 新增

- 保留原有官方浏览器登录，并新增可选的“协议登录（实验）”。
- 协议登录支持交互式邮箱验证码、密码、TOTP、工作区选择、手机号验证和 Codex OAuth。
- 协议登录完成后自动转换并验证 Codex `auth.json`，验证通过后进入账号池。
- 支持协议登录失败、取消和重新发起，登录输入不会写入 Codex Navo 配置。

### 说明

- 协议登录不会同步 Chrome Cookie，网页端仍需单独登录。
- 新增 toSub2 MIT 许可证及第三方来源说明。

## 1.1.33

### 新增

- 新增“授权健康与迁移”工具，可检查单个或全部账号的 Codex 授权状态。
- 新增单文件 `.codexnavo` 授权包导入导出，无需密码或额外密钥文件。
- 授权流程支持中断状态持久化，应用重启后可以继续或取消。

### 改进

- 导入授权包时执行完整性检查、重复账号识别和在线可用性验证。
- 授权工具弹窗锁定底层页面滚动，并在弹窗内显示检查和导入结果。
- 精简授权包导出区域的界面提示。

### 修复

- 修复退出应用后本地服务进程可能继续驻留，导致安装或更新提示程序仍在运行的问题。
- 安装程序在替换文件前主动结束旧版 Codex Navo 进程，提高升级成功率。

### 安全与范围

- `.codexnavo` 只迁移 Codex 官方授权和必要账号标识，不包含 Chrome Cookie、密码、项目、任务或网页历史。
- 新增 `*.codexnavo` Git 忽略规则，降低授权包被误提交的风险。

## 1.1.27

### 新增

- 新增本机 Codex Token 用量统计，支持今日、昨日、近 7 天、近 30 天和全部范围。
- 显示模型调用、输入 Token、缓存输入、输出 Token、缓存命中率和 Token 估值。
- 增加总量与单账号统计，并支持列表用量详情折叠。

### 改进

- 重新设计本机用量、列表视图和卡片视图的数据布局。
- Token 主值保留 `M` 单位，一亿以上额外显示中文“亿”单位提示。
- 将容易误解的“请求”和“API 等值”调整为“模型调用”和“Token 估值”。

### 修复

- 修复 Codex 会话移动到归档目录后可能被重复统计的问题。
- 改进共享 Codex 历史用量按账号启动区间归属的准确性。

## 1.1.18

- 新增了账号唤醒功能、修了点Bug。

## 1.1.3（本地测试）

### 改进

- GitHub 仓库和自动更新源调整为 `1080ssf/codex-navo`
- README、发布指南与克隆地址同步使用新项目名

## 1.1.2（本地测试）

### 改进

- 产品显示名称正式调整为 `Codex Navo`
- 外部 Codex 运行状态改为更醒目的暖色提示，并强化一键关闭入口
- 继续沿用旧版数据目录，确保升级后保留账号环境

## 1.1.1（本地测试）

### 改进

- 桌面显示名称缩写为 `CSB`
- 顶栏 Codex 运行状态按窗口几何中心对齐
- 检测到非账号池启动的 Codex 时，提供带确认的一键关闭按钮

## 1.1.0（本地测试）

### 新增

- Windows NSIS 安装程序
- 启动后自动检查 GitHub Releases，每六小时重新检查
- 应用内下载进度、版本说明和重启安装确认
- 顶栏版本状态入口和手动检查更新

### 数据安全

- 运行数据迁移到 `%LOCALAPPDATA%\Codex Switchboard`
- 升级和卸载默认保留账号池、浏览器配置与 Codex 认证目录
- 支持从旧版程序目录一次性复制现有账号环境，不覆盖目标目录已有数据

## 1.0.0

首个公开版本。

### 功能

- 独立 Chrome/Edge 账号环境
- ChatGPT 网页登录与 Codex 设备授权引导
- Codex 桌面端账号切换与本地项目保留
- 套餐、点数和周额度显示
- 自动刷新、全部刷新和账号排序
- Windows 系统托盘驻留

### 修复

- 修复空表单无法关闭“添加账号”弹窗的问题
- 修复关闭主窗口会直接退出应用的问题

### 安全

- 本地服务只监听 `127.0.0.1`
- 运行凭据、账号配置、日志和浏览器目录默认不进入 Git
- Release 不包含账号数据、Cookie、Codex 认证文件或本机路径
