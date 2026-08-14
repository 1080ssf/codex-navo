const state = { accounts: [], csrfToken: '', timer: null, sessionTimer: null, notificationTimer: null, launchProgressTimer: null, launchProgress: null, launchProgressDismissed: false, launchProgressStartedAt: '', launchProgressCompleteKey: '', quotaRefreshing: false, wakeSettings: {}, wakeModelOptions: [], networkSettings: { core: {}, sources: [], assignments: {} }, apiService: { config: {}, providers: [], keys: [], baseUrl: '' }, sessions: { connected: false, tasks: [], counts: {} }, sessionFilter: 'all', sessionCollapsed: new Set(), sessionAllSeenGroups: new Set(), notificationSettings: {}, notificationEventId: 0, networkSourceId: '', accountNetworkId: '', usage: null, importPackageText: '', accountImportPackageText: '', relayImportPackageText: '', protocolDialogAccountId: '', protocolDialogPromptKind: '', localeCatalog: null };
let toolsStatusTimer = null;
const elements = {
  accounts: document.querySelector('#accounts'),
  summary: document.querySelector('#account-summary'),
  dialog: document.querySelector('#account-dialog'),
  form: document.querySelector('#account-form'),
  accountDialogStatus: document.querySelector('#account-dialog-status'),
  accountDialogCopy: document.querySelector('#account-dialog-copy'),
  accountManualFields: document.querySelector('#account-manual-fields'),
  accountFixedBrowser: document.querySelector('#account-fixed-browser'),
  accountImportPanel: document.querySelector('#account-import-panel'),
  accountImportPackageFile: document.querySelector('#account-import-package-file'),
  accountImportFileName: document.querySelector('#account-import-file-name'),
  accountSubmit: document.querySelector('#account-submit'),
  accountCreateRoute: document.querySelector('#account-create-route'),
  protocolProgress: document.querySelector('#protocol-dialog-progress'),
  protocolProgressTitle: document.querySelector('#protocol-progress-title'),
  protocolProgressCopy: document.querySelector('#protocol-progress-copy'),
  protocolProgressInput: document.querySelector('#protocol-progress-input'),
  protocolProgressCancel: document.querySelector('#protocol-progress-cancel'),
  protocolProgressRetry: document.querySelector('#protocol-progress-retry'),
  protocolProgressClose: document.querySelector('#protocol-progress-close'),
  toast: document.querySelector('#toast'),
  codexLaunchStatus: document.querySelector('#codex-launch-status'),
  codexLaunchStatusTitle: document.querySelector('#codex-launch-status-title'),
  codexLaunchStatusMessage: document.querySelector('#codex-launch-status-message'),
  codexLaunchStatusAccount: document.querySelector('#codex-launch-status-account'),
  codexLaunchStatusPercent: document.querySelector('#codex-launch-status-percent'),
  codexLaunchStatusBar: document.querySelector('#codex-launch-status-bar'),
  codexLaunchStatusClose: document.querySelector('#codex-launch-status-close'),
  appWorkspace: document.querySelector('#app-workspace'),
  appPages: [...document.querySelectorAll('[data-app-page]')],
  sidebarToggle: document.querySelector('#sidebar-toggle'),
  sidebarAccountButton: document.querySelector('#sidebar-account-button'),
  appSettingsButton: document.querySelector('#app-settings-button'),
  placeholderDialog: document.querySelector('#placeholder-dialog'),
  placeholderDialogTitle: document.querySelector('#placeholder-dialog-title'),
  currentCodex: document.querySelector('#current-codex'),
  closeExternalCodex: document.querySelector('#close-external-codex'),
  sortMenu: document.querySelector('#sort-menu'),
  sortTrigger: document.querySelector('#sort-trigger'),
  sortLabel: document.querySelector('#sort-label'),
  sortPopover: document.querySelector('#sort-popover'),
  viewSwitcher: document.querySelector('#view-switcher'),
  floatingWindowButton: document.querySelector('#floating-window-button'),
  relayImportDialog: document.querySelector('#relay-import-dialog'),
  relayImportForm: document.querySelector('#relay-import-form'),
  relayImportClose: document.querySelector('#relay-import-close'),
  relayImportCancel: document.querySelector('#relay-import-cancel'),
  relayImportChoose: document.querySelector('#relay-import-choose'),
  relayImportFile: document.querySelector('#relay-import-file'),
  relayImportFileName: document.querySelector('#relay-import-file-name'),
  relayImportResult: document.querySelector('#relay-import-result'),
  relayImportSubmit: document.querySelector('#relay-import-submit'),
  refreshAllQuotas: document.querySelector('#refresh-all-quotas'),
  wakeAll: document.querySelector('#wake-all'),
  wakeSettingsButton: document.querySelector('#wake-settings-button'),
  wakeForm: document.querySelector('#wake-form'),
  wakeModelHelp: document.querySelector('#wake-model-help'),
  accountToolsButton: document.querySelector('#account-tools-button'),
  networkSettingsButton: document.querySelector('#network-settings-button'),
  networkSourceForm: document.querySelector('#network-source-form'),
  networkSourceList: document.querySelector('#network-source-list'),
  networkCoreState: document.querySelector('#network-core-state'),
  networkResult: document.querySelector('#network-result'),
  addNetworkSource: document.querySelector('#add-network-source'),
  accountNetworkDialog: document.querySelector('#account-network-dialog'),
  accountNetworkForm: document.querySelector('#account-network-form'),
  accountNetworkCopy: document.querySelector('#account-network-copy'),
  accountNetworkRoute: document.querySelector('#account-network-route'),
  accountNetworkPreview: document.querySelector('#account-network-preview'),
  accountNetworkEmpty: document.querySelector('#account-network-empty'),
  accountNetworkResult: document.querySelector('#account-network-result'),
  manageAccountNetwork: document.querySelector('#manage-account-network'),
  testAccountNetwork: document.querySelector('#test-account-network'),
  saveAccountNetwork: document.querySelector('#save-account-network'),
  healthList: document.querySelector('#health-list'),
  checkAllHealth: document.querySelector('#check-all-health'),
  toolsStatus: document.querySelector('#tools-status'),
  exportAccount: document.querySelector('#export-account'),
  exportAuthPackage: document.querySelector('#export-auth-package'),
  importPackageFile: document.querySelector('#import-package-file'),
  importFileName: document.querySelector('#import-file-name'),
  importAuthPackage: document.querySelector('#import-auth-package'),
  updateChip: document.querySelector('#update-chip'),
  updateDialog: document.querySelector('#update-dialog'),
  updateDialogCopy: document.querySelector('#update-dialog-copy'),
  navoCurrentVersion: document.querySelector('#navo-current-version'),
  updateProgress: document.querySelector('#update-progress'),
  updateProgressBar: document.querySelector('#update-progress-bar'),
  updateProgressLabel: document.querySelector('#update-progress-label'),
  updateNotes: document.querySelector('#update-notes'),
  updatePrimaryAction: document.querySelector('#update-primary-action'),
  navoSettingsVersion: document.querySelector('#navo-settings-version'),
  navoSettingsUpdateCopy: document.querySelector('#navo-settings-update-copy'),
  navoSettingsProgress: document.querySelector('#navo-settings-progress'),
  navoSettingsProgressBar: document.querySelector('#navo-settings-progress-bar'),
  navoSettingsProgressLabel: document.querySelector('#navo-settings-progress-label'),
  navoSettingsUpdateAction: document.querySelector('#navo-settings-update-action'),
  codexUpdateCopy: document.querySelector('#codex-update-copy'),
  codexCurrentVersion: document.querySelector('#codex-current-version'),
  codexUpdateAction: document.querySelector('#codex-update-action'),
  usageOverview: document.querySelector('#usage-overview'),
  usageLedger: document.querySelector('#usage-ledger'),
  usageUpdated: document.querySelector('#usage-updated'),
  usageRange: document.querySelector('#usage-range'),
  apiDocBaseUrl: document.querySelector('#api-doc-base-url'),
  apiDocExample: document.querySelector('#api-doc-example'),
  apiKeyAdd: document.querySelector('#api-key-add'),
  apiKeyList: document.querySelector('#api-key-list'),
  sessionRefresh: document.querySelector('#session-refresh'),
  sessionOverview: document.querySelector('#session-overview'),
  sessionRunningCount: document.querySelector('#session-running-count'),
  sessionWaitingCount: document.querySelector('#session-waiting-count'),
  sessionCompletedCount: document.querySelector('#session-completed-count'),
  sessionFailedCount: document.querySelector('#session-failed-count'),
  sessionTotalCount: document.querySelector('#session-total-count'),
  sessionFilters: document.querySelector('#session-filters'),
  sessionClearFailed: document.querySelector('#session-clear-failed'),
  sessionList: document.querySelector('#session-list'),
  notificationForm: document.querySelector('#notification-form'),
  notificationTestLocal: document.querySelector('#notification-test-local'),
  notificationSoundImport: document.querySelector('#notification-sound-import'),
  notificationSoundName: document.querySelector('#notification-sound-name'),
  notificationVolumeValue: document.querySelector('#notification-volume-value'),
  languageForm: document.querySelector('#language-form'),
  appLanguageSelect: document.querySelector('#app-language-select'),
  languageStatus: document.querySelector('#language-status'),
};

const localeStorageKey = 'codex-navo-app-locale';
function systemLocale() {
  const value = navigator.languages?.[0] || navigator.language || 'en-US';
  if (/^zh(?:-|$)/i.test(value)) return /(?:TW|HK)/i.test(value) ? (/HK/i.test(value) ? 'zh-HK' : 'zh-TW') : 'zh-CN';
  return value;
}
state.appLocale = localStorage.getItem(localeStorageKey) || systemLocale();
function navoUsesChinese() { return state.appLocale === 'zh-CN'; }
document.documentElement.lang = state.appLocale;
const englishUi = new Map([
  ['账号管理', 'Accounts'], ['网络代理', 'Network'], ['授权迁移', 'Authorization'], ['会话管理', 'Sessions'],
  ['通知提醒', 'Notifications'], ['API 服务', 'API Service'], ['唤醒设置', 'Wake Settings'], ['语言设置', 'Language'], ['应用设置', 'Application Settings'],
  ['账号池', 'Account Pool'], ['添加账号', 'Add Account'], ['本机用量', 'Local Usage'], ['今日', 'Today'], ['昨日', 'Yesterday'],
  ['全部', 'All'], ['立即刷新', 'Refresh'], ['本机会话', 'Local Sessions'], ['进行中', 'Active'], ['失败', 'Failed'], ['本机提醒', 'Local Alerts'],
  ['启用提醒', 'Enable alerts'], ['通知文案', 'Notification message'], ['提示音', 'Sound'], ['音量', 'Volume'], ['任务完成', 'Completed'],
  ['显示 Windows 通知', 'Show Windows notifications'], ['试听并测试', 'Preview & test'], ['保存设置', 'Save'], ['消息平台', 'Message channels'],
  ['测试连接', 'Test'], ['创建 Key', 'Create Key'], ['自动唤醒', 'Automatic wake'], ['执行策略', 'Schedule'], ['模型', 'Model'],
  ['推理强度', 'Reasoning effort'], ['发送内容', 'Prompt'], ['立即唤醒全部', 'Wake All Now'], ['应用与 Codex 默认语言', 'App and Codex default language'],
  ['保存语言', 'Save Language'], ['界面语言', 'Interface language'], ['取消', 'Cancel'], ['按所选内容启动', 'Launch Selected'],
  ['全选项目和会话', 'Select all projects and sessions'], ['全部展开', 'Expand all'], ['全部折叠', 'Collapse all'],
  ['启动前优化超大历史会话', 'Optimize oversized conversation history before launch'], ['账号与顺序', 'Accounts & Order'],
  ['登录 Codex', 'Launch Codex'], ['退出 Codex', 'Quit Codex'], ['网页端', 'Web'], ['柔和提示音', 'Soft chime'],
  ['清亮提示音', 'Bright chime'], ['玻璃音', 'Glass'], ['脉冲音', 'Pulse'], ['完成音', 'Success'], ['导入音频', 'Imported audio'], ['静音', 'Silent'],
  ['柔和确认', 'Soft confirmation'], ['明亮确认', 'Bright confirmation'], ['玻璃轻响', 'Glass chime'], ['低音提醒', 'Low notice'],
  ['等待提醒', 'Waiting alert'], ['错误提醒', 'Error alert'], ['弹拨提示', 'Pluck'], ['轻敲提示', 'Tap'],
  ['内置音效来自 Kenney Interface Sounds（CC0）；支持导入最大 5 MB 音频', 'Built-in sounds are from Kenney Interface Sounds (CC0); imported audio can be up to 5 MB'],
  ['调整系统通知和提示音的播放音量', 'Adjust the playback volume for system alerts and notification sounds'],
  ['总 Token', 'Total Tokens'], ['Token 估值', 'Token estimate'], ['模型调用', 'Model calls'], ['输入', 'Input'], ['输出', 'Output'], ['缓存率', 'Cache rate'],
  ['输入与输出合计', 'Input and output total'], ['近实时记录', 'Near real-time'], ['从现在开始记录', 'Recording from now'],
  ['当前账号优先', 'Current account first'], ['剩余额度：高到低', 'Quota: high to low'], ['剩余额度：低到高', 'Quota: low to high'],
  ['账号名称', 'Account name'], ['最近添加', 'Recently added'], ['排序方式', 'Sort order'], ['置顶使用中账号', 'Pin active accounts'],
  ['优先选择额度充足账号', 'Prioritize accounts with more quota'], ['快速找到额度较低账号', 'Find low-quota accounts'],
  ['按名称顺序排列', 'Sort by name'], ['新账号排在前面', 'Newest accounts first'], ['账号池可用额度', 'Combined account quota'],
  ['刷新额度', 'Refresh quota'], ['唤醒账号', 'Wake account'], ['配置账号网络', 'Configure account network'],
  ['直连', 'Direct'], ['代理', 'Proxy'], ['额度刷新失败', 'Quota refresh failed'], ['正在读取额度', 'Loading quota'],
  ['等待登录授权', 'Waiting for sign-in'], ['登录已失效', 'Sign-in expired'], ['重新登录授权', 'Sign in again'],
  ['任务已完成', 'Task completed'], ['任务执行失败', 'Task failed'], ['任务已中断', 'Task interrupted'], ['等待输入', 'Waiting for input'],
  ['等待授权', 'Waiting for approval'], ['通知测试成功', 'Notification test successful'], ['监控已连接', 'Monitor connected'],
  ['运行中', 'Running'], ['等待处理', 'Waiting'], ['今日完成', 'Completed today'], ['失败或中断', 'Failed or interrupted'], ['历史会话', 'History'],
  ['导入本地音频', 'Import local audio'], ['任务失败或中断', 'Failed or interrupted'], ['等待输入或授权', 'Waiting for input or approval'],
  ['当前使用完整简体中文界面。', 'Full Simplified Chinese interface is active.'],
  ['Codex 未启动', 'Codex is not running'], ['检查更新', 'Check for updates'], ['收起', 'Collapse'], ['正在读取本地状态…', 'Loading local state…'],
  ['7 天', '7 days'], ['30 天', '30 days'], ['按 API Token 公价估算', 'Estimated at public API token prices'],
  ['集中管理代理订阅与节点，并为每个账号分配独立线路。', 'Manage proxy subscriptions and nodes, with an independent route for each account.'],
  ['线路名称', 'Route name'], ['可选', 'Optional'], ['节点或订阅', 'Node or subscription'], ['添加线路', 'Add route'],
  ['代理核心将在首次添加节点时自动准备', 'The proxy core will be prepared when the first node is added'], ['还没有节点或订阅', 'No nodes or subscriptions yet'],
  ['检查账号授权状态，或通过授权包迁移 Codex 与可用的网页会话。', 'Check account authorization or migrate Codex and available web sessions with an authorization package.'],
  ['账号健康', 'Account health'], ['检查全部', 'Check all'], ['账号授权包', 'Account authorization package'], ['导出授权', 'Export authorization'],
  ['生成单个 .codexnavo 账号授权包', 'Create one .codexnavo account package'], ['选择账号', 'Select account'], ['生成授权包', 'Create package'],
  ['导入授权', 'Import authorization'], ['验证通过后创建新的 Codex 账号环境', 'Create a new Codex account environment after validation'], ['授权包', 'Authorization package'],
  ['选择 .codexnavo 文件', 'Choose a .codexnavo file'], ['验证并导入', 'Validate and import'],
  ['实时读取本机 Codex 会话，查看运行、等待处理和最近完成的任务。', 'Read local Codex sessions in real time and review active, waiting, and recently completed tasks.'],
  ['正在连接会话监控', 'Connecting to session monitor'], ['读取 ~/.codex/sessions', 'Reading ~/.codex/sessions'], ['正在读取本机会话…', 'Loading local sessions…'],
  ['设置任务完成、失败或等待操作时的系统通知、提示音和消息机器人。', 'Configure system notifications, sounds, and message bots for completed, failed, or waiting tasks.'],
  ['飞书', 'Feishu'], ['钉钉', 'DingTalk'],
  ['把已授权的 Codex 账号池转换为 OpenAI 兼容 API，并使用 Navo API Key 管理访问权限。', 'Expose the authorized Codex account pool as an OpenAI-compatible API and manage access with Navo API keys.'],
  ['API 文档', 'API documentation'], ['兼容 OpenAI 调用格式，使用创建的 Navo API Key 访问。', 'OpenAI-compatible request format using a generated Navo API key.'],
  ['复制', 'Copy'], ['复制格式', 'Copy format'], ['读取当前 Key 可访问的模型', 'Models available to the current key'], ['Codex 与 Responses 客户端调用', 'Codex and Responses clients'],
  ['兼容 OpenAI Chat Completions', 'OpenAI Chat Completions compatible'], ['请求示例', 'Request example'], ['复制示例', 'Copy example'],
  ['创建供客户端使用的 Bearer Key，并配置权限与额度。', 'Create Bearer keys for clients and configure permissions and limits.'],
  ['设置自动唤醒策略、模型、推理强度与发送内容。', 'Configure automatic wake schedules, models, reasoning effort, and prompts.'],
  ['默认关闭；开启后按下方策略执行', 'Off by default; when enabled, uses the schedule below'], ['仅手动唤醒', 'Manual only'], ['每天唤醒一次', 'Once daily'],
  ['额度重置后唤醒一次', 'Once after quota reset'], ['每日执行时间', 'Daily time'], ['正在读取 Codex 模型…', 'Loading Codex models…'], ['模型默认', 'Model default'],
  ['设置 Codex Navo 界面语言，并同步为启动 Codex 时的默认语言。', 'Set the Codex Navo interface language and use it as the default when launching Codex.'],
  ['应用与 Codex 默认语言', 'App and Codex default language'], ['保存语言', 'Save language'], ['添加账号环境', 'Add account environment'],
  ['邮箱提示', 'Email hint'], ['登录方式', 'Sign-in method'], ['添加方式', 'Add method'], ['登录并授权', 'Sign in and authorize'], ['推荐', 'Recommended'], ['导入已有账号', 'Import existing account'],
  ['创建 API', 'Create API'], ['导入第三方数据包', 'Import third-party package'], ['临时账号', 'Temporary accounts'], ['临时', 'Temporary'],
  ['创建与 API 服务页面相同的 Navo API Key，并一次性显示完整 Key', 'Create the same Navo API key as the API Service page and show the full key once'],
  ['支持 Sub2API、CLIProxyAPI、Cockpit、9router、AxonHub 等 JSON 数据包', 'Supports Sub2API, CLIProxyAPI, Cockpit, 9router, AxonHub, and other JSON packages'],
  ['网络线路', 'Network route'], ['浏览器', 'Browser'], ['正在登录并授权', 'Signing in and authorizing'], ['重新授权', 'Authorize again'], ['完成', 'Done'],
  ['账号网络', 'Account network'], ['连接方式', 'Connection mode'], ['网页端和 Codex 均不使用代理', 'Web and Codex use a direct connection'], ['还没有可用节点', 'No available nodes'], ['检测当前线路', 'Test selected route'],
  ['管理节点', 'Manage nodes'], ['保存线路', 'Save route'], ['应用更新', 'Application update'], ['当前安装版本', 'Installed version'], ['正在读取版本信息。', 'Loading version information.'],
  ['一个选项同时控制 Navo 界面和每次启动 Codex 时预选的语言。', 'One setting controls the Navo interface and the language preselected whenever Codex is launched.'],
  ['选择语言', 'Choose language'], ['跟随 Windows', 'Follow Windows'], ['首次打开时自动识别系统语言。保存个人选择后，将优先使用你的设置。', 'The system language is detected on first launch. Your saved preference takes priority afterward.'],
  ['自动识别', 'Auto detected'], ['同步 Codex', 'Sync Codex'], ['打开普通账号或 API Codex 时，启动窗口会自动预选相同语言。', 'The same language is preselected when launching a regular account or API Codex.'],
  ['已同步', 'Synced'], ['简体中文提供完整中文界面；其他语言当前使用英文 Navo 界面，Codex 使用所选语言。', 'Simplified Chinese has a complete Chinese interface. Other locales currently use the English Navo interface while Codex uses the selected language.'],
  ['有任务已处理完毕。', 'A task has been processed.'],
  ['首次打开跟随 Windows，保存后同时作为 Navo 界面和 Codex 启动语言。', 'Follows Windows on first launch, then uses your saved choice for both Navo and Codex.'],
  ['展开', 'Expand'], ['展开侧边栏', 'Expand sidebar'], ['折叠侧边栏', 'Collapse sidebar'], ['读取中', 'Loading'],
  ['检查应用更新', 'Check for updates'], ['打开应用更新', 'Open app update'], ['更新检查失败', 'Update check failed'], ['正在检查', 'Checking'],
  ['重启并安装', 'Restart and install'], ['重新检查', 'Check again'], ['下载更新', 'Download update'], ['重启更新', 'Restart to update'],
  ['检查 GitHub Releases 是否有新版本。', 'Check GitHub Releases for a newer version.'], ['已是最新版', 'Up to date'],
  ['开发模式', 'Development mode'], ['开发模式不会连接更新服务，请安装本地构建的 Setup 版本测试。', 'Development mode does not connect to the update service. Install the locally built Setup package to test.'],
  ['无法连接更新服务，请稍后重试。', 'Could not connect to the update service. Try again later.'],
  ['代理核心将在首次添加节点时自动准备', 'The proxy core is prepared when the first node is added'], ['检测', 'Test'], ['检测全部', 'Test all'],
  ['刷新', 'Refresh'], ['删除', 'Delete'], ['检查', 'Check'], ['授权', 'Authorize'], ['继续', 'Continue'], ['权限', 'Permissions'], ['停用', 'Disable'], ['启用', 'Enable'],
  ['授权正常', 'Authorized'], ['本地凭证完整，可直接启动 Codex', 'Local credentials are complete; Codex is ready to launch'],
  ['临时凭证正常', 'Temporary credential ready'], ['临时凭证已导入，额度读取暂时失败', 'Temporary credential imported; quota is temporarily unavailable'],
  ['导入第三方反代账号', 'Import third-party relay accounts'], ['导入反代账号', 'Import relay accounts'],
  ['第三方数据包', 'Third-party data package'], ['选择 JSON 文件', 'Choose JSON file'], ['尚未选择文件', 'No file selected'],
  ['反代账号', 'Relay accounts'], ['网页端', 'Web'], ['登录 Codex', 'Launch Codex'],
  ['导入的账号只参与本机 API 反代与轮转，不会创建网页环境，也不会打开 Codex 桌面端。', 'Imported accounts only participate in the local API relay and rotation. They do not create web profiles or open Codex Desktop.'],
  ['模型默认', 'Model default'], ['低', 'Low'], ['中', 'Medium'], ['高', 'High'], ['超高', 'Extra high'], ['最大', 'Maximum'],
  ['由 Codex 决定', 'Codex default'], ['普通账号', 'Regular accounts'], ['API Codex', 'API Codex'], ['模型', 'Model'],
  ['当前 Navo 使用英文回退界面，Codex 将使用所选语言。', 'Navo is using the English interface. Codex will use the selected language.'],
  ['已保存。Codex 使用所选语言，Navo 将使用英文回退界面。', 'Saved. Navo is using English and Codex will use the selected language.'],
  ['移除账号', 'Remove account'], ['释放账号占用', 'Release account'], ['请先退出当前 Codex', 'Quit the current Codex first'], ['请先通过顶部入口关闭外部 Codex', 'Close the external Codex from the top bar first'],
  ['配置账号网络', 'Configure account network'], ['释放账号占用（不会关闭网页）', 'Release account use without closing the web session'],
  ['继续授权', 'Continue authorization'], ['设备代码', 'Device code'], ['取消授权', 'Cancel authorization'], ['打开网页登录', 'Open web sign-in'],
  ['网页已打开', 'Web is open'], ['关闭后启动', 'Launch after closing'], ['暂不可切换', 'Switch unavailable'], ['登录并授权', 'Sign in and authorize'],
  ['API账号与使用顺序', 'API accounts and order'], ['按从上到下的顺序请求，额度耗尽或失败时切换下一个账号。', 'Requests use the order below and switch accounts when quota is exhausted or a request fails.'],
  ['新建 Key 默认不选择账号。展开分类后勾选，并在分类内调整使用顺序。', 'New keys start with no accounts selected. Expand a group to select accounts and adjust their order.'],
  ['暂无可用账号', 'No available accounts'], ['模型检测未完成', 'Model detection incomplete'],
  ['API Key 已创建', 'API key created'], ['复制 API Key', 'Copy API key'], ['尚未复制', 'Not copied'], ['已复制', 'Copied'], ['已复制到剪贴板', 'Copied to clipboard'],
  ['账号顺序', 'Account order'], ['全部可用账号（自动择优）', 'All available accounts (automatic selection)'],
  ['还没有 Navo API Key。完整 Key 只会在创建成功后显示一次。', 'No Navo API key yet. The complete key is shown only once after creation.'],
  ['暂无账号', 'No accounts yet'], ['点击右上角“添加账号”创建第一个独立登录环境。', 'Use Add Account in the upper-right to create the first isolated sign-in environment.'],
  ['重试', 'Retry'], ['刷新失败，当前显示上次数据', 'Refresh failed; showing previous data'], ['重新授权后会自动读取额度', 'Quota loads automatically after authorization'],
  ['在独立浏览器完成官方流程后会自动入池', 'Complete the official flow in the isolated browser to add this account'], ['已入池账号会自动刷新', 'Authorized accounts refresh automatically'],
  ['本机用户', 'Local user'], ['重置时间未知', 'Reset time unknown'], ['未知项目', 'Unknown project'], ['未命名会话', 'Untitled session'], ['默认模型', 'Default model'], ['等待新任务', 'Waiting for a new task'],
  ['项目与会话', 'Projects and conversations'], ['当前会话', 'Current conversations'], ['已归档', 'Archived'], ['归档', 'Archive'], ['归档会话', 'Archive conversation'], ['删除会话', 'Delete conversation'],
  ['清空失败项', 'Clear failed'], ['清空失败或中断会话', 'Clear failed or interrupted conversations'], ['清空方式', 'Clear mode'], ['仅清空列表（保留本地数据）', 'Clear list only (keep local data)'], ['清空列表和本地数据', 'Clear list and local data'], ['确认清空', 'Clear'],
  ['显示悬浮窗', 'Show floating window'], ['隐藏悬浮窗', 'Hide floating window'],
  ['请输入通知渠道要发送的内容', 'Enter the message to send through notification channels'],
  ['保存什么内容，飞书、钉钉或 Telegram 就原样发送什么内容', 'Feishu, DingTalk, and Telegram send the saved message exactly as written'],
  ['选择只从 Navo 会话列表隐藏，或同时删除 Codex 本地会话文件与索引记录。', 'Hide the conversations from the Navo list only, or also delete their local Codex files and index records.'],
  ['仅清空列表可以保留 Codex 原始会话；删除本地数据后会从 Codex 中一并移除。', 'List-only cleanup preserves the original Codex conversations. Local-data cleanup also removes them from Codex.'],
  ['失败或中断的会话文件和索引记录将被永久删除。', 'The failed or interrupted conversation files and index records will be permanently deleted.'],
  ['确认删除本地数据？', 'Delete local data?'], ['失败会话及本地数据已清空', 'Failed conversations and local data cleared'], ['失败会话已从列表清空', 'Failed conversations cleared from the list'],
  ['其他会话', 'Other sessions'], ['未归类项目', 'Unassigned project'], ['当前没有正在运行或等待处理的会话', 'No active or waiting sessions'], ['当前没有失败或中断的会话', 'No failed or interrupted conversations'],
  ['通知设置已保存', 'Notification settings saved'], ['通知测试已发送', 'Test notification sent'], ['语言设置已保存', 'Language settings saved'],
  ['管理界面语言、Codex 启动语言以及 Codex Navo 与 Codex 桌面端更新。', 'Manage interface language, the Codex launch language, and updates for Codex Navo and Codex Desktop.'],
  ['应用更新', 'Application updates'], ['Navo 桌面应用', 'Navo desktop app'], ['Microsoft Store 桌面应用', 'Microsoft Store desktop app'],
  ['正在读取版本和更新状态。', 'Loading version and update status.'], ['正在读取本机安装版本。', 'Loading the installed version.'], ['检查并更新', 'Check and update'], ['打开 Microsoft Store', 'Open Microsoft Store'],
  ['社区与项目', 'Community and project'], ['加入社区交流使用经验、反馈问题，或前往 GitHub 查看项目源码与版本动态。', 'Join the community to share feedback, or visit GitHub for source code and releases.'],
  ['Telegram 群组', 'Telegram group'], ['加入 TG 社区', 'Join the Telegram community'], ['QQ 群', 'QQ group'], ['加入中文交流群', 'Join the Chinese community'], ['GitHub 项目', 'GitHub project'], ['源码、Issue 与版本', 'Source, issues, and releases'],
  ['正在通过 Windows 包管理器检查并安装 Codex 更新，请不要关闭 Navo。', 'Checking and installing the Codex update through Windows Package Manager. Keep Navo open.'],
  ['请先退出 Codex，再点击“检查并更新”。关闭 Codex 可避免 Microsoft Store 安装包被占用。', 'Quit Codex, then select Check and update. This prevents the Microsoft Store package from being locked.'],
  ['Codex 已是 Microsoft Store 当前提供的最新版。', 'Codex is up to date with the latest Microsoft Store version.'], ['Codex 更新失败，请尝试从 Microsoft Store 更新。', 'Codex update failed. Try updating from Microsoft Store.'],
]);
const englishUiPatterns = [
  [/^当前 Codex · /, 'Current Codex · '],
  [/^(\d+) 个账号/, '$1 accounts'], [/ · (\d+) 个 Navo API/g, ' · $1 Navo API'], [/^(\d+) 使用中$/, '$1 active'],
  [/^更新于 /, 'Updated '], [/ 次待定价$/, ' unpriced calls'], [/^缓存率 /, 'Cache rate '], [/其中推理 /, 'Reasoning '],
  [/^按 (\d+) 个绑定账号的总额度平均计算$/, 'Average of total quota across $1 linked accounts'],
  [/^(\d+) 个底层账号$/, '$1 backing accounts'], [/^代理 · (\d+)$/, 'Proxy · $1'], [/^已选 (\d+) 个项目、(\d+) 个会话$/, '$1 projects and $2 sessions selected'],
  [/^(\d+) 个会话$/, '$1 sessions'], [/^实时读取 /, 'Reading '], [/^还没有读取到本地 Codex 会话$/, 'No local Codex sessions found'],
  [/^今日用量$/, 'Today usage'], [/^昨日用量$/, 'Yesterday usage'], [/^近 7 天$/, 'Last 7 days'], [/^近 30 天$/, 'Last 30 days'], [/^全部记录$/, 'All records'],
  [/^(\d+) 次待定价$/, '$1 unpriced calls'], [/^约 ([\d.]+) 亿$/, 'About $1 hundred million'],
  [/^(\d+) 秒$/, '$1 sec'], [/^(\d+) 分钟$/, '$1 min'], [/^(\d+) 小时 (\d+) 分$/, '$1 hr $2 min'], [/^(\d+) 分钟前$/, '$1 min ago'], [/^(\d+) 小时前$/, '$1 hr ago'], [/^(\d+) 天前$/, '$1 days ago'],
  [/^已选 (\d+) \/ (\d+)$/, '$1 / $2 selected'], [/^已读取 (\d+) 个模型，请勾选要使用的模型$/, '$1 models loaded; select the models to use'],
  [/^已刷新全部 (\d+) 个账号额度$/, 'Refreshed quota for all $1 accounts'], [/^已刷新 (\d+) 个账号，(\d+) 个刷新失败$/, 'Refreshed $1 accounts; $2 failed'],
  [/^已唤醒 (\d+) 个账号，(\d+) 个失败$/, 'Woke $1 accounts; $2 failed'], [/^已成功唤醒全部 (\d+) 个账号$/, 'Successfully woke all $1 accounts'],
  [/^(\d+) 个账号使用代理$/, '$1 accounts use a proxy'], [/^已读取 (\d+) 个节点$/, '$1 nodes loaded'], [/^已识别 (\d+) 个节点$/, '$1 nodes recognized'],
  [/^按 (\d+) 个绑定账号的总额度平均计算$/, 'Average across the total quota of $1 linked accounts'],
];
function translateText(value) {
  const trimmed = String(value || '').trim();
  let translated = englishUi.get(trimmed) || trimmed;
  for (const [pattern, replacement] of englishUiPatterns) translated = translated.replace(pattern, replacement);
  return translated === trimmed ? value : String(value).replace(trimmed, translated);
}
function translateUi(root = document.body) {
  if (navoUsesChinese()) return;
  if (root.nodeType === Node.TEXT_NODE) {
    const translated = translateText(root.nodeValue);
    if (translated !== root.nodeValue) root.nodeValue = translated;
    return;
  }
  if (root.matches?.('input[type="button"], input[type="submit"]') && root.value) {
    const translated = translateText(root.value);
    if (translated !== root.value) root.value = translated;
  }
  for (const name of ['title', 'aria-label', 'placeholder']) {
    const value = root.getAttribute?.(name);
    if (!value) continue;
    const translated = translateText(value);
    if (translated !== value) root.setAttribute(name, translated);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const translated = translateText(node.nodeValue);
      if (translated !== node.nodeValue) node.nodeValue = translated;
    }
    else {
      if (node.matches?.('input[type="button"], input[type="submit"]') && node.value) {
        const translated = translateText(node.value);
        if (translated !== node.value) node.value = translated;
      }
      for (const name of ['title', 'aria-label', 'placeholder']) {
        const value = node.getAttribute(name);
        if (!value) continue;
        const translated = translateText(value);
        if (translated !== value) node.setAttribute(name, translated);
      }
    }
  }
}
const translationObserver = new MutationObserver((records) => {
  if (navoUsesChinese()) return;
  for (const record of records) {
    if (record.type === 'characterData') translateUi(record.target);
    else for (const node of record.addedNodes) translateUi(node);
  }
});
translationObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true });
queueMicrotask(() => translateUi());

const sidebarStorageKey = 'codex-navo-sidebar-collapsed';
const accountGroupsStorageKey = 'codex-navo-account-groups';
try { state.accountGroups = { api: false, relay: false, regular: false, ...JSON.parse(localStorage.getItem(accountGroupsStorageKey) || '{}') }; }
catch { state.accountGroups = { api: false, relay: false, regular: false }; }

function syncSidebar(collapsed = localStorage.getItem(sidebarStorageKey) === 'true') {
  elements.appWorkspace.classList.toggle('sidebar-collapsed', collapsed);
  elements.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  elements.sidebarToggle.setAttribute('aria-label', collapsed ? '展开侧边栏' : '折叠侧边栏');
  elements.sidebarToggle.querySelector('span').textContent = collapsed ? '展开' : '收起';
}

function setSidebarActive(section = 'accounts') {
  document.querySelectorAll('[data-sidebar-section]').forEach((button) => {
    const active = button.dataset.sidebarSection === section;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function showAppPage(section = 'accounts') {
  setSidebarActive(section);
  elements.appPages.forEach((page) => {
    const active = page.dataset.appPage === section;
    page.hidden = !active;
    page.classList.toggle('active', active);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

syncSidebar();


let applicationUpdate = {
  status: 'idle',
  currentVersion: '',
  availableVersion: '',
  percent: 0,
  releaseNotes: '',
  error: '',
};

function renderApplicationUpdate() {
  if (!window.codexUpdater) {
    elements.updateChip.hidden = true;
    return;
  }

  const status = applicationUpdate.status;
  const currentVersion = applicationUpdate.currentVersion || '';
  const availableVersion = applicationUpdate.availableVersion || '';
  const percent = Math.max(0, Math.min(100, Number(applicationUpdate.percent) || 0));
  const labels = {
    idle: currentVersion ? `v${currentVersion}` : '检查更新',
    development: currentVersion ? `v${currentVersion}` : '开发模式',
    checking: '正在检查',
    current: currentVersion ? `v${currentVersion}` : '已是最新版',
    available: `v${availableVersion} 可更新`,
    downloading: `下载 ${percent}%`,
    downloaded: '重启更新',
    error: '更新检查失败',
  };

  elements.updateChip.hidden = false;
  elements.updateChip.className = `update-chip ${status}`;
  elements.updateChip.querySelector('span').textContent = labels[status] || labels.idle;
  elements.updateChip.setAttribute('aria-label', status === 'available' || status === 'downloaded'
    ? '打开应用更新'
    : '检查应用更新');

  elements.navoCurrentVersion.textContent = currentVersion ? `v${currentVersion}` : '读取中';
  const statusCopy = status === 'available'
    ? `当前版本 v${currentVersion}。下载完成后由你决定何时重启安装。`
    : status === 'downloading'
      ? '正在后台下载更新，账号数据和登录环境不会被覆盖。'
      : status === 'downloaded'
        ? '更新已经下载完成。重启应用即可安装，正在运行的 Codex 不会被强制关闭。'
        : status === 'current'
          ? `当前 v${currentVersion} 已是最新版。`
          : status === 'development'
            ? '开发模式不会连接更新服务，请安装本地构建的 Setup 版本测试。'
            : status === 'error'
              ? (applicationUpdate.error || '无法连接更新服务，请稍后重试。')
              : '检查 GitHub Releases 是否有新版本。';
  elements.updateDialogCopy.textContent = statusCopy;
  if (elements.navoSettingsUpdateCopy) elements.navoSettingsUpdateCopy.textContent = statusCopy;
  if (elements.navoSettingsVersion) elements.navoSettingsVersion.textContent = currentVersion ? `v${currentVersion}` : '读取中';

  elements.updateProgress.hidden = status !== 'downloading';
  elements.updateProgressBar.style.width = `${percent}%`;
  elements.updateProgressLabel.textContent = `${percent}%`;
  if (elements.navoSettingsProgress) elements.navoSettingsProgress.hidden = status !== 'downloading';
  if (elements.navoSettingsProgressBar) elements.navoSettingsProgressBar.style.width = `${percent}%`;
  if (elements.navoSettingsProgressLabel) elements.navoSettingsProgressLabel.textContent = `${percent}%`;
  const notes = String(applicationUpdate.releaseNotes || '').trim();
  elements.updateNotes.hidden = !(notes && status === 'available');
  elements.updateNotes.textContent = notes;

  elements.updatePrimaryAction.hidden = status === 'downloading';
  elements.updatePrimaryAction.disabled = status === 'checking';
  elements.updatePrimaryAction.dataset.action = status === 'available'
    ? 'download'
    : status === 'downloaded'
      ? 'install'
      : 'check';
  elements.updatePrimaryAction.textContent = status === 'available'
    ? '下载更新'
    : status === 'downloaded'
      ? '重启并安装'
      : status === 'checking'
        ? '正在检查'
        : '重新检查';
  if (elements.navoSettingsUpdateAction) {
    elements.navoSettingsUpdateAction.hidden = status === 'downloading';
    elements.navoSettingsUpdateAction.disabled = status === 'checking';
    elements.navoSettingsUpdateAction.dataset.action = elements.updatePrimaryAction.dataset.action;
    elements.navoSettingsUpdateAction.textContent = elements.updatePrimaryAction.textContent;
  }
}

async function initializeApplicationUpdater() {
  if (!window.codexUpdater) return;
  try {
    applicationUpdate = await window.codexUpdater.getState();
    renderApplicationUpdate();
    window.codexUpdater.onState((nextState) => {
      applicationUpdate = nextState;
      renderApplicationUpdate();
    });
  } catch {
    elements.updateChip.hidden = true;
  }
}

async function initializeFloatingWindow() {
  if (!window.codexFloating || !elements.floatingWindowButton) {
    if (elements.floatingWindowButton) elements.floatingWindowButton.hidden = true;
    return;
  }
  const apply = (settings = {}) => {
    const visible = settings.enabled === true;
    elements.floatingWindowButton.classList.toggle('active', visible);
    const label = visible
      ? (navoUsesChinese() ? '隐藏悬浮窗' : 'Hide floating window')
      : (navoUsesChinese() ? '显示悬浮窗' : 'Show floating window');
    elements.floatingWindowButton.dataset.tooltip = label;
    elements.floatingWindowButton.setAttribute('aria-label', label);
  };
  try { apply(await window.codexFloating.getSettings()); } catch {}
  window.codexFloating.onSettings(apply);
}

const sortStorageKey = 'codex-manager-account-sort';
const viewStorageKey = 'codex-navo-account-view';
const usageRangeStorageKey = 'codex-navo-usage-range';
const expandedUsageStorageKey = 'codex-navo-expanded-account-usage';
const sortLabels = {
  current: '当前账号优先',
  'quota-desc': '额度：高到低',
  'quota-asc': '额度：低到高',
  name: '账号名称',
  created: '最近添加',
};
state.sortMode = localStorage.getItem(sortStorageKey) || 'current';
state.viewMode = localStorage.getItem(viewStorageKey) === 'grid' ? 'grid' : 'list';
state.usageRange = ['today', 'yesterday', '7d', '30d', 'all'].includes(localStorage.getItem(usageRangeStorageKey))
  ? localStorage.getItem(usageRangeStorageKey)
  : 'today';
try {
  const savedExpandedUsage = JSON.parse(localStorage.getItem(expandedUsageStorageKey) || '[]');
  state.expandedUsage = new Set(savedExpandedUsage.filter((id) => !String(id).startsWith('api-key:')));
} catch {
  state.expandedUsage = new Set();
}

function applyViewMode() {
  elements.accounts.classList.toggle('account-grid', state.viewMode === 'grid');
  elements.viewSwitcher.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === state.viewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function formatPlan(planType) {
  const normalized = String(planType || '').trim().toLowerCase();
  const labels = {
    plus: 'PLUS',
    pro: 'PRO',
    team: 'TEAM',
    business: 'BUSINESS',
    enterprise: 'ENTERPRISE',
    edu: 'EDU',
    free: 'FREE',
  };
  return labels[normalized] || normalized.toUpperCase();
}

function creditQuantity(credits) {
  const candidate = credits?.quantity ?? credits?.points ?? credits?.rawBalance;
  const numeric = Number(candidate);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : null;
}

function formatCredits(credits) {
  if (!credits) return '';
  if (credits.unlimited) return 'Credits ∞';
  const quantity = creditQuantity(credits);
  if (quantity == null) return '';
  return `Credits ${quantity.toLocaleString('en-US')}`;
}

function formatUsdBalance(credits) {
  if (!credits || credits.unlimited) return '';
  const amount = Number(credits.usdBalance);
  return Number.isFinite(amount)
    ? `US$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '';
}

function weeklyRemaining(account) {
  const weekly = account.quota?.windows?.find((window) => Number(window.windowDurationMins) >= 6 * 24 * 60)
    || account.quota?.windows?.[0];
  const remaining = Number(weekly?.remainingPercent);
  return Number.isFinite(remaining) ? remaining : null;
}

function formatTokenCount(value, compact = false) {
  const number = Math.max(0, Number(value) || 0);
  return compact && number >= 10_000
    ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(number)
    : Math.round(number).toLocaleString('en-US');
}

function formatYiTokenNote(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number < 100_000_000) return '';
  const amount = (number / 100_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return `<em class="token-scale-note">约 ${amount} 亿</em>`;
}

function formatUsageCost(usage) {
  if (!usage || !usage.pricedRequests) return '—';
  const value = Number(usage.estimatedCostUsd) || 0;
  const digits = value < 0.01 ? 4 : 2;
  const prefix = usage.unpricedRequests ? '≥' : '';
  return `${prefix}US$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function formatCacheHitRate(usage) {
  const inputTokens = Math.max(0, Number(usage?.inputTokens) || 0);
  if (!inputTokens) return '—';
  const cachedTokens = Math.min(inputTokens, Math.max(0, Number(usage?.cachedInputTokens) || 0));
  const percentage = cachedTokens / inputTokens * 100;
  return `${percentage.toLocaleString('zh-CN', { minimumFractionDigits: percentage === 100 ? 0 : 1, maximumFractionDigits: 1 })}%`;
}

function renderUsage() {
  const usage = state.usage || {};
  const totals = mergedLocalUsageTotals(usage.totals || {});
  elements.usageRange.querySelectorAll('[data-range]').forEach((button) => {
    const active = button.dataset.range === state.usageRange;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  const updated = usage.updatedAt ? new Date(usage.updatedAt) : null;
  elements.usageUpdated.textContent = updated && !Number.isNaN(updated.getTime())
    ? `更新于 ${updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`
    : '从启用统计后开始记录';
  elements.usageLedger.innerHTML = `
    <div class="usage-primary">
      <div><span>总 Token</span>${formatYiTokenNote(totals.totalTokens)}<strong title="${formatTokenCount(totals.totalTokens)}">${formatTokenCount(totals.totalTokens, true)}</strong><small>输入与输出合计</small></div>
      <div class="usage-cost"><span>Token 估值</span><strong>${formatUsageCost(totals)}</strong><small>${totals.unpricedRequests ? `${formatTokenCount(totals.unpricedRequests)} 次待定价` : '按 API Token 公价估算'}</small></div>
    </div>
    <div class="usage-breakdown">
      <div class="usage-metric"><span>模型调用</span><strong>${formatTokenCount(totals.requests)}</strong><small>${state.usageRange === 'today' ? '近实时记录' : '所选时段'}</small></div>
      <div class="usage-metric"><span>输入</span><strong title="${formatTokenCount(totals.inputTokens)}">${formatTokenCount(totals.inputTokens, true)}</strong><small>缓存率 ${formatCacheHitRate(totals)}</small></div>
      <div class="usage-metric"><span>输出</span><strong title="${formatTokenCount(totals.outputTokens)}">${formatTokenCount(totals.outputTokens, true)}</strong><small>其中推理 ${formatTokenCount(totals.reasoningOutputTokens, true)}</small></div>
    </div>`;
}

function apiUsageInSelectedRange(usage = {}) {
  const usedAt = Date.parse(usage.lastUsedAt || '');
  if (!Number.isFinite(usedAt)) return state.usageRange === 'all';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (state.usageRange === 'today') return usedAt >= startToday;
  if (state.usageRange === 'yesterday') return usedAt >= startToday - 86_400_000 && usedAt < startToday;
  if (state.usageRange === '7d') return usedAt >= startToday - 6 * 86_400_000;
  if (state.usageRange === '30d') return usedAt >= startToday - 29 * 86_400_000;
  return true;
}

function mergedLocalUsageTotals(localTotals = {}) {
  const merged = { ...localTotals };
  for (const key of state.apiService?.keys || []) {
    const usage = key.usage || {};
    if (!apiUsageInSelectedRange(usage)) continue;
    merged.requests = Number(merged.requests || 0) + Number(usage.requests || 0);
    merged.inputTokens = Number(merged.inputTokens || 0) + Number(usage.inputTokens || 0);
    merged.cachedInputTokens = Number(merged.cachedInputTokens || 0) + Number(usage.cachedInputTokens || 0);
    merged.outputTokens = Number(merged.outputTokens || 0) + Number(usage.outputTokens || 0);
    merged.reasoningOutputTokens = Number(merged.reasoningOutputTokens || 0) + Number(usage.reasoningOutputTokens || 0);
    merged.estimatedCostUsd = Number(merged.estimatedCostUsd || 0) + Number(usage.estimatedCostUsd || 0);
    merged.pricedRequests = Number(merged.pricedRequests || 0) + Number(usage.pricedRequests || 0);
    merged.unpricedRequests = Number(merged.unpricedRequests || 0) + Number(usage.unpricedRequests || 0);
    merged.estimatedCostApproximate = merged.estimatedCostApproximate === true || usage.estimatedCostApproximate === true;
  }
  merged.totalTokens = Number(merged.inputTokens || 0) + Number(merged.outputTokens || 0);
  return merged;
}

function renderAccountUsage(account) {
  const usage = state.usage?.accounts?.[account.id] || {};
  return renderUsageStrip(usage);
}

function renderUsageStrip(usage = {}) {
  usage = {
    ...usage,
    totalTokens: Number(usage.totalTokens ?? (Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0))) || 0,
  };
  const rangeLabels = { today: '今日用量', yesterday: '昨日用量', '7d': '近 7 天', '30d': '近 30 天', all: '全部记录' };
  return `<div class="account-usage-strip" aria-label="账号用量">
    <div class="account-usage-title">
      <span><i></i>${rangeLabels[state.usageRange] || '用量'}</span>
      <div class="account-usage-total"><strong title="${formatTokenCount(usage.totalTokens)}">${formatTokenCount(usage.totalTokens, true)} <small>Token</small></strong>${formatYiTokenNote(usage.totalTokens)}</div>
    </div>
    <div class="account-usage-line">
      <b>${formatTokenCount(usage.requests)} <small>模型调用</small></b>
      <b class="usage-estimate">${formatUsageCost(usage)} <small>Token 估值</small></b>
      <span>输入 ${formatTokenCount(usage.inputTokens, true)} · 缓存率 ${formatCacheHitRate(usage)} · 输出 ${formatTokenCount(usage.outputTokens, true)}</span>
    </div>
  </div>`;
}

function sortedAccounts(activeAccount, source = state.accounts) {
  const accounts = source.map((account, index) => ({ account, index }));
  const mode = state.sortMode;
  accounts.sort((left, right) => {
    const a = left.account;
    const b = right.account;
    if (mode === 'current') {
      const activeDifference = Number(b.id === activeAccount?.id) - Number(a.id === activeAccount?.id);
      return activeDifference || left.index - right.index;
    }
    if (mode === 'quota-desc' || mode === 'quota-asc') {
      const aQuota = weeklyRemaining(a);
      const bQuota = weeklyRemaining(b);
      if (aQuota === null || bQuota === null) {
        if (aQuota === null && bQuota === null) return left.index - right.index;
        return aQuota === null ? 1 : -1;
      }
      return mode === 'quota-desc' ? bQuota - aQuota : aQuota - bQuota;
    }
    if (mode === 'name') {
      return String(a.label || '').localeCompare(String(b.label || ''), 'zh-CN', { sensitivity: 'base' });
    }
    if (mode === 'created') {
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    }
    return left.index - right.index;
  });
  return accounts.map(({ account }) => account);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function showToast(message, error = false) {
  elements.toast.textContent = message;
  elements.toast.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => { elements.toast.className = 'toast'; }, 3200);
}

function setLaunchControlsDisabled(disabled) {
  document.querySelectorAll('[data-action="codex"], [data-action="api-codex-launch"]').forEach((button) => {
    button.disabled = disabled;
    button.setAttribute('aria-busy', String(disabled));
  });
}

function renderCodexLaunchProgress(progress = state.launchProgress) {
  if (!elements.codexLaunchStatus || !progress || progress.stage === 'idle') return;
  if (progress.startedAt && progress.startedAt !== state.launchProgressStartedAt) {
    state.launchProgressStartedAt = progress.startedAt;
    state.launchProgressDismissed = false;
    state.launchProgressCompleteKey = '';
    clearTimeout(renderCodexLaunchProgress.hideTimer);
  }
  state.launchProgress = progress;
  const failed = progress.stage === 'error';
  const complete = progress.stage === 'complete';
  const visible = !state.launchProgressDismissed && (progress.active || failed || complete);
  elements.codexLaunchStatus.hidden = !visible;
  elements.codexLaunchStatus.classList.toggle('error', failed);
  elements.codexLaunchStatus.classList.toggle('complete', complete);
  elements.codexLaunchStatusTitle.textContent = failed
    ? (navoUsesChinese() ? 'Codex 启动失败' : 'Codex launch failed')
    : complete
      ? (navoUsesChinese() ? 'Codex 已打开' : 'Codex is open')
      : (navoUsesChinese() ? '正在启动 Codex' : 'Launching Codex');
  elements.codexLaunchStatusMessage.textContent = navoUsesChinese() ? progress.message : ({
    '正在准备启动环境…': 'Preparing the launch environment…',
    '正在检测代理可用性…': 'Checking proxy availability…',
    '正在加载项目与会话…': 'Loading projects and sessions…',
    '正在切换账号授权…': 'Switching account authorization…',
    '正在准备 API 授权环境…': 'Preparing the API authorization environment…',
    '正在初始化 Codex 服务…': 'Initializing Codex services…',
    '正在打开 Codex…': 'Opening Codex…',
    '正在等待 Codex 窗口…': 'Waiting for the Codex window…',
    'Codex 已打开': 'Codex is open',
  }[progress.message] || progress.message);
  elements.codexLaunchStatusAccount.textContent = progress.label || 'Codex';
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  elements.codexLaunchStatusPercent.textContent = `${percent}%`;
  elements.codexLaunchStatusBar.style.width = `${percent}%`;
  setLaunchControlsDisabled(progress.active === true);
  if (complete && !state.launchProgressDismissed) {
    const completeKey = progress.completedAt || progress.updatedAt || progress.startedAt || 'complete';
    if (state.launchProgressCompleteKey !== completeKey) {
      state.launchProgressCompleteKey = completeKey;
      clearTimeout(renderCodexLaunchProgress.hideTimer);
      const completedAt = Date.parse(progress.completedAt || '');
      const remaining = Number.isFinite(completedAt) ? Math.max(0, 1800 - (Date.now() - completedAt)) : 1800;
      renderCodexLaunchProgress.hideTimer = setTimeout(() => {
        state.launchProgressDismissed = true;
        elements.codexLaunchStatus.hidden = true;
      }, remaining);
    }
  }
}

function beginLaunchUi(kind, label) {
  state.launchProgressDismissed = false;
  state.launchProgressStartedAt = '';
  state.launchProgressCompleteKey = '';
  clearTimeout(renderCodexLaunchProgress.hideTimer);
  renderCodexLaunchProgress({ active: true, kind, label, stage: 'preparing', message: '正在准备启动环境…', percent: 6 });
}

async function pollCodexLaunchProgress() {
  try { renderCodexLaunchProgress(await api('/api/codex-launch-progress')); } catch {}
}

function openApiFormDialog({ eyebrow = 'API SERVICE', title, copy = '', submitLabel = '保存', fields = [], onReady = null }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'api-editor-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">${escapeHtml(eyebrow)}</p><h2>${escapeHtml(title)}</h2></div><button class="icon-button" type="button" data-api-dialog-close aria-label="关闭">×</button></div>${copy ? `<p class="dialog-copy">${escapeHtml(copy)}</p>` : ''}<div class="api-editor-fields"></div><div class="dialog-actions"><button class="secondary-button" type="button" data-api-dialog-cancel>取消</button><button class="primary-button" type="submit">${escapeHtml(submitLabel)}</button></div>`;
    const fieldRoot = form.querySelector('.api-editor-fields');
    for (const field of fields) {
      if (field.type === 'hidden') {
        const control = document.createElement('input');
        control.type = 'hidden';
        control.name = field.name;
        control.value = field.value ?? '';
        fieldRoot.appendChild(control);
        continue;
      }
      const label = document.createElement('label');
      label.dataset.apiFieldRow = field.name;
      const labelText = document.createElement('span');
      labelText.textContent = field.label;
      label.appendChild(labelText);
      let control;
      if (field.type === 'select') {
        control = document.createElement('select');
        for (const option of field.options || []) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = option.label;
          control.appendChild(node);
        }
      } else if (field.type === 'textarea') {
        control = document.createElement('textarea');
        control.rows = field.rows || 3;
      } else {
        control = document.createElement('input');
        control.type = field.type || 'text';
      }
      control.name = field.name;
      control.value = field.value ?? '';
      if (field.placeholder) control.placeholder = field.placeholder;
      if (field.required) control.required = true;
      if (field.min != null) control.min = String(field.min);
      label.appendChild(control);
      if (field.help) {
        const help = document.createElement('small');
        help.textContent = field.help;
        label.appendChild(help);
      }
      fieldRoot.appendChild(label);
    }
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const finish = (value) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      syncModalScrollLock();
      resolve(value);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries());
      finish(values);
    });
    form.querySelector('[data-api-dialog-close]').addEventListener('click', () => finish(null));
    form.querySelector('[data-api-dialog-cancel]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.showModal();
    syncModalScrollLock();
    if (typeof onReady === 'function') onReady({ dialog, form, finish });
    queueMicrotask(() => form.querySelector('input:not([type="hidden"]), select, textarea')?.focus());
  });
}

function openApiConfirmDialog(message, title = '确认操作') {
  return openApiFormDialog({
    eyebrow: 'CONFIRM',
    title,
    copy: message,
    submitLabel: '确认',
  }).then((result) => result !== null);
}

function openApiSecretDialog(secret) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'api-editor-dialog api-secret-dialog';
    dialog.innerHTML = `<div class="dialog-head"><div><p class="eyebrow">KEY CREATED</p><h2>API Key 已创建</h2></div><button class="icon-button" type="button" data-secret-close aria-label="关闭">×</button></div><p class="dialog-copy">完整 Key 只在这里显示一次。请立即复制并保存，关闭后不会再次显示。</p><div class="api-secret-value"><code>${escapeHtml(secret)}</code></div><p class="api-secret-status" aria-live="polite">尚未复制</p><div class="dialog-actions"><button class="secondary-button" type="button" data-secret-copy>复制 API Key</button><button class="primary-button" type="button" data-secret-close>关闭</button></div>`;
    document.body.appendChild(dialog);
    const finish = () => {
      if (dialog.open) dialog.close();
      dialog.remove();
      syncModalScrollLock();
      resolve();
    };
    dialog.querySelectorAll('[data-secret-close]').forEach((button) => button.addEventListener('click', finish));
    dialog.querySelector('[data-secret-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(secret);
      } catch {
        const input = document.createElement('textarea');
        input.value = secret;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      dialog.querySelector('.api-secret-status').textContent = '已复制到剪贴板';
      dialog.querySelector('[data-secret-copy]').textContent = '已复制';
    });
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(); });
    dialog.showModal();
    syncModalScrollLock();
  });
}

function formatLaunchSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function openCodexLaunchDialog() {
  const catalog = await api('/api/codex-launch-options');
  state.localeCatalog = catalog;
  catalog.defaultLanguage = catalog.languages.some((item) => item.id === state.appLocale) ? state.appLocale : catalog.defaultLanguage;
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'codex-launch-dialog';
    const form = document.createElement('form');
    form.method = 'dialog';
    const projectMarkup = catalog.projects.map((project) => `
      <section class="launch-project collapsed" data-launch-project-section="${escapeHtml(project.id)}">
        <div class="launch-project-head"><label><input type="checkbox" data-launch-project value="${escapeHtml(project.id)}" checked><span><strong>${escapeHtml(project.label)}</strong><small>${project.threads.length} 个会话${project.roots?.[0] ? ` · ${escapeHtml(project.roots[0])}` : ''}</small></span></label><div class="launch-project-actions"><button type="button" data-launch-only="${escapeHtml(project.id)}">仅选此项目</button><button type="button" data-launch-toggle="${escapeHtml(project.id)}" aria-expanded="false" aria-label="展开项目会话"><span>›</span></button></div></div>
        <div class="launch-thread-list">${project.threads.map((thread) => `
          <label class="launch-thread"><input type="checkbox" data-launch-thread data-project-id="${escapeHtml(project.id)}" value="${escapeHtml(thread.id)}" checked><span><strong>${escapeHtml(thread.title)}</strong><small>${escapeHtml(thread.cwd || '本地会话')}</small></span><em class="${thread.oversized ? 'oversized' : ''}">${formatLaunchSize(thread.sizeBytes)}</em></label>
        `).join('') || '<p class="launch-empty">该项目目前没有本地会话</p>'}</div>
      </section>`).join('');
    form.innerHTML = `
      <div class="dialog-head"><div><p class="eyebrow">CODEX LAUNCH</p><h2>选择本次加载内容</h2></div><button class="icon-button" type="button" data-launch-close aria-label="关闭">×</button></div>
      <p class="dialog-copy">普通账号和 API 模式共用这组选项。未勾选的项目与会话不会在本次启动中加载，原始数据仍会保留。</p>
      <label class="launch-language"><span>界面语言</span><div class="launch-language-control"><i>文</i><select name="language">${catalog.languages.map((item) => `<option value="${escapeHtml(item.id)}"${item.id === catalog.defaultLanguage ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></div></label>
      <div class="launch-select-bar"><label><input type="checkbox" data-launch-all checked><span>全选项目和会话</span></label><div><small data-launch-selected>已选 ${catalog.projects.length} 个项目、${catalog.threadCount} 个会话</small><button type="button" data-launch-collapse-all>全部展开</button></div><progress class="launch-selection-progress" data-launch-progress value="100" max="100">100%</progress></div>
      <div class="launch-projects">${projectMarkup || '<p class="launch-empty">尚未找到可加载的本地项目或会话</p>'}</div>
      <label class="launch-optimize"><input type="checkbox" name="optimizeOversized" checked><span><strong>启动前优化超大历史会话</strong><small>仅清理重复压缩快照，并在 .codex/navo-rollout-backups 中保留原文件备份。</small></span></label>
      <div class="dialog-actions"><button class="secondary-button" type="button" data-launch-cancel>取消</button><button class="primary-button" type="submit">按所选内容启动</button></div>`;
    dialog.appendChild(form);
    document.body.appendChild(dialog);
    const all = form.querySelector('[data-launch-all]');
    const projects = [...form.querySelectorAll('[data-launch-project]')];
    const threads = [...form.querySelectorAll('[data-launch-thread]')];
    const sections = [...form.querySelectorAll('[data-launch-project-section]')];
    const selectedSummary = form.querySelector('[data-launch-selected]');
    const collapseAll = form.querySelector('[data-launch-collapse-all]');
    const selectionProgress = form.querySelector('[data-launch-progress]');
    const sync = () => {
      for (const project of projects) {
        const children = threads.filter((thread) => thread.dataset.projectId === project.value);
        if (children.length) {
          project.checked = children.every((thread) => thread.checked);
          project.indeterminate = children.some((thread) => thread.checked) && !project.checked;
        }
      }
      const controls = [...projects, ...threads];
      all.checked = controls.length === 0 || controls.every((control) => control.checked);
      all.indeterminate = controls.some((control) => control.checked) && !all.checked;
      selectedSummary.textContent = `已选 ${projects.filter((item) => item.checked || item.indeterminate).length} 个项目、${threads.filter((item) => item.checked).length} 个会话`;
      const total = projects.length + threads.length;
      selectionProgress.value = total ? Math.round((projects.filter((item) => item.checked || item.indeterminate).length + threads.filter((item) => item.checked).length) / total * 100) : 100;
    };
    const setSectionCollapsed = (section, collapsed) => {
      section.classList.toggle('collapsed', collapsed);
      const toggle = section.querySelector('[data-launch-toggle]');
      toggle.setAttribute('aria-expanded', String(!collapsed));
      toggle.setAttribute('aria-label', collapsed ? '展开项目会话' : '折叠项目会话');
    };
    const syncCollapseAll = () => {
      const allCollapsed = sections.every((section) => section.classList.contains('collapsed'));
      collapseAll.textContent = allCollapsed ? '全部展开' : '全部折叠';
    };
    all.addEventListener('change', () => { [...projects, ...threads].forEach((control) => { control.checked = all.checked; control.indeterminate = false; }); sync(); });
    projects.forEach((project) => project.addEventListener('change', () => {
      threads.filter((thread) => thread.dataset.projectId === project.value).forEach((thread) => { thread.checked = project.checked; });
      sync();
    }));
    threads.forEach((thread) => thread.addEventListener('change', sync));
    form.querySelectorAll('[data-launch-toggle]').forEach((button) => button.addEventListener('click', () => {
      const section = button.closest('[data-launch-project-section]');
      setSectionCollapsed(section, !section.classList.contains('collapsed'));
      syncCollapseAll();
    }));
    form.querySelectorAll('[data-launch-only]').forEach((button) => button.addEventListener('click', () => {
      const projectId = button.dataset.launchOnly;
      projects.forEach((project) => { project.checked = project.value === projectId; project.indeterminate = false; });
      threads.forEach((thread) => { thread.checked = thread.dataset.projectId === projectId; });
      sections.forEach((section) => setSectionCollapsed(section, section.dataset.launchProjectSection !== projectId));
      sync();
      syncCollapseAll();
    }));
    collapseAll.addEventListener('click', () => {
      const expand = sections.every((section) => section.classList.contains('collapsed'));
      sections.forEach((section) => setSectionCollapsed(section, !expand));
      syncCollapseAll();
    });
    const finish = (value) => {
      if (dialog.open) dialog.close();
      dialog.remove();
      syncModalScrollLock();
      resolve(value);
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      finish({
        language: form.elements.language.value,
        projectIds: projects.filter((item) => item.checked || item.indeterminate).map((item) => item.value),
        threadIds: threads.filter((item) => item.checked).map((item) => item.value),
        optimizeOversized: form.elements.optimizeOversized.checked,
      });
    });
    form.querySelector('[data-launch-close]').addEventListener('click', () => finish(null));
    form.querySelector('[data-launch-cancel]').addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); });
    dialog.showModal();
    syncModalScrollLock();
  });
}

function parseModelList(value) {
  return [...new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function mountModelPicker({ form, fieldName = 'models', buttonLabel = '检测并读取模型', loadModels }) {
  const control = form.elements[fieldName];
  const row = form.querySelector(`[data-api-field-row="${fieldName}"]`);
  if (!control || !row) return;
  const panel = document.createElement('div');
  panel.className = 'api-model-picker';
  panel.innerHTML = `<div class="api-model-picker-bar"><button class="secondary-button api-model-detect" type="button">${escapeHtml(buttonLabel)}</button><span class="api-model-status">填写连接信息后检测</span></div><div class="api-model-options" hidden></div>`;
  row.insertAdjacentElement('afterend', panel);
  const button = panel.querySelector('.api-model-detect');
  const status = panel.querySelector('.api-model-status');
  const options = panel.querySelector('.api-model-options');
  const render = (records) => {
    const selected = new Set(parseModelList(control.value));
    options.innerHTML = records.map((record) => {
      const value = String(record.value || record.id || record);
      const label = String(record.label || record.id || record);
      const checked = selected.has(value) || selected.has(value.split('/').slice(-1)[0]);
      return `<label class="api-model-option"><input type="checkbox" value="${escapeHtml(value)}"${checked ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
    }).join('');
    options.hidden = false;
    options.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
      control.value = [...options.querySelectorAll('input:checked')].map((item) => item.value).join(', ');
    }));
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.className = 'api-model-status loading';
    status.textContent = '正在读取账号池可用模型…';
    try {
      const records = await loadModels();
      if (!records.length) throw new Error('没有读取到可用模型');
      render(records);
      status.className = 'api-model-status success';
      status.textContent = `已读取 ${records.length} 个模型，请勾选要使用的模型`;
    } catch (error) {
      status.className = 'api-model-status error';
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

function mountAccountPoolPicker({ form, fieldName = 'accountIds', accounts = [], selectedIds = [] }) {
  const control = form.elements[fieldName];
  if (!control) return;
  const selected = new Set(selectedIds);
  const rank = new Map(selectedIds.map((id, index) => [id, index]));
  const ordered = [...accounts].sort((left, right) => {
    const a = rank.has(left.id) ? rank.get(left.id) : Number.MAX_SAFE_INTEGER;
    const b = rank.has(right.id) ? rank.get(right.id) : Number.MAX_SAFE_INTEGER;
    return a - b || String(left.label || '').localeCompare(String(right.label || ''), 'zh-CN');
  });
  const panel = document.createElement('section');
  panel.className = 'api-account-picker';
  panel.innerHTML = `<div class="api-account-picker-head"><div><strong>API账号与使用顺序</strong><small>新建 Key 默认不选择账号。展开分类后勾选，并在分类内调整使用顺序。</small></div><span data-account-count></span></div><div class="api-account-groups"></div>`;
  const modelRow = form.querySelector('[data-api-field-row="models"]');
  modelRow.insertAdjacentElement('beforebegin', panel);
  const groupsRoot = panel.querySelector('.api-account-groups');
  const sync = () => {
    const rows = [...groupsRoot.querySelectorAll('.api-account-option')];
    const ids = rows.filter((row) => row.querySelector('input').checked).map((row) => row.dataset.accountId);
    control.value = ids.join(',');
    panel.querySelector('[data-account-count]').textContent = `已选 ${ids.length} / ${rows.length}`;
    groupsRoot.querySelectorAll('.api-account-options').forEach((options) => {
      const groupRows = [...options.querySelectorAll('.api-account-option')];
      groupRows.forEach((row, index) => {
        row.querySelector('[data-account-up]').disabled = index === 0;
        row.querySelector('[data-account-down]').disabled = index === groupRows.length - 1;
      });
    });
  };
  for (const group of [
    { kind: 'regular', label: '普通账号', accounts: ordered.filter((account) => account.accountKind !== 'relay') },
    { kind: 'relay', label: '临时账号', accounts: ordered.filter((account) => account.accountKind === 'relay') },
  ]) {
    const section = document.createElement('section');
    section.className = 'api-account-group';
    section.dataset.accountPickerGroup = group.kind;
    section.innerHTML = `<button class="api-account-group-head" type="button" aria-expanded="true"><span><strong>${group.label}</strong><small>${group.accounts.length} 个可用账号</small></span><i>−</i></button><div class="api-account-options"></div>`;
    const options = section.querySelector('.api-account-options');
    for (const account of group.accounts) {
      const row = document.createElement('div');
      const remaining = weeklyRemaining(account);
      row.className = 'api-account-option';
      row.dataset.accountId = account.id;
      row.innerHTML = `<label><input type="checkbox"${selected.has(account.id) ? ' checked' : ''}><strong>${escapeHtml(account.label)}</strong><small>${remaining == null ? '额度未知' : `${remaining}%`}</small></label><div class="api-account-order"><button type="button" data-account-up title="上移">↑</button><button type="button" data-account-down title="下移">↓</button></div>`;
      row.querySelector('input').addEventListener('change', sync);
      row.querySelector('[data-account-up]').addEventListener('click', () => { row.previousElementSibling?.before(row); sync(); });
      row.querySelector('[data-account-down]').addEventListener('click', () => { row.nextElementSibling?.after(row); sync(); });
      options.appendChild(row);
    }
    if (!group.accounts.length) options.innerHTML = '<p class="api-account-group-empty">暂无可用账号</p>';
    section.querySelector('.api-account-group-head').addEventListener('click', (event) => {
      const collapsed = section.classList.toggle('collapsed');
      event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
      event.currentTarget.querySelector('i').textContent = collapsed ? '＋' : '−';
    });
    groupsRoot.appendChild(section);
  }
  sync();
}

function showAccountDialogError(message) {
  elements.accountDialogStatus.textContent = String(message || '操作失败');
  elements.accountDialogStatus.className = 'account-dialog-status error';
  elements.accountDialogStatus.hidden = false;
}

async function readAuthorizationPackageFile(file, { onName, onClear }) {
  if (!file) {
    onName('选择 .codexnavo 文件');
    return '';
  }
  onName(file.name);
  if (file.size > 768 * 1024) {
    onClear();
    onName('文件过大，请选择有效授权包');
    throw new Error('授权包文件过大');
  }
  try {
    return await file.text();
  } catch {
    throw new Error('无法读取授权包文件');
  }
}

function syncAccountLoginMethod() {
  const method = String(new FormData(elements.form).get('loginMethod') || 'official');
  const importing = method === 'import';
  const creatingApi = method === 'create-api';
  const importingRelay = method === 'relay-import';
  const accountFlow = method === 'official' || importing;
  const labelInput = elements.form.elements.label;
  const emailInput = elements.form.elements.emailHint;
  elements.accountImportPanel.hidden = !importing;
  elements.accountManualFields.hidden = method !== 'official';
  elements.form.querySelector('.account-create-network').hidden = !accountFlow;
  elements.accountFixedBrowser.hidden = !accountFlow;
  labelInput.required = method === 'official';
  labelInput.disabled = method !== 'official';
  emailInput.disabled = method !== 'official';
  emailInput.placeholder = '例如：de***@company.com';
  elements.accountDialogCopy.textContent = importing
    ? '选择 .codexnavo 授权包，恢复已保存的 Codex 授权和网页会话。'
    : creatingApi
      ? '创建一个本机 Navo API Key。完整 Key 只显示一次，请在关闭前复制保存。'
      : importingRelay
        ? '导入第三方账号数据包并加入“临时账号”，仅用于本机 API 反代与轮转。'
        : '创建独立账号环境，并在 Chrome 中完成官方登录与 Codex OAuth。';
  elements.accountSubmit.textContent = importing ? '导入账号' : creatingApi ? '创建 API' : importingRelay ? '选择数据包' : '登录并授权';
}

function renderProtocolPrompt(login, action = 'protocol-input') {
  const kind = String(login?.promptKind || '');
  const otp = ['email_otp', 'totp', 'phone_otp'].includes(kind);
  const phone = kind === 'phone';
  const type = kind === 'password' ? 'password' : phone ? 'tel' : 'text';
  const autocomplete = kind === 'password' ? 'current-password' : otp ? 'one-time-code' : 'off';
  const inputMode = otp ? 'numeric' : phone ? 'tel' : 'text';
  const submitLabel = phone ? '确认手机号' : kind === 'password' ? '确认密码' : otp ? '确认验证码' : '确认';
  const maxlength = phone ? 16 : otp ? 8 : 256;
  return `<strong>${escapeHtml(login.promptLabel || '继续验证')}</strong>
    <small>${escapeHtml(login.promptHint || '输入仅传给当前登录进程，不会保存。')}</small>
    <div class="protocol-inline-input" data-prompt-kind="${escapeHtml(kind)}">
      <input type="${type}" inputmode="${inputMode}" autocomplete="${autocomplete}" maxlength="${maxlength}" placeholder="${escapeHtml(login.promptLabel || '请输入')}" aria-label="${escapeHtml(login.promptLabel || '协议登录输入')}">
      <button data-action="${escapeHtml(action)}" type="button">${submitLabel}</button>
    </div>`;
}

function resetProtocolDialog() {
  state.protocolDialogAccountId = '';
  state.protocolDialogPromptKind = '';
  elements.form.classList.remove('protocol-progress-active');
  elements.protocolProgress.hidden = true;
  elements.protocolProgress.className = 'protocol-dialog-progress';
  elements.protocolProgressInput.innerHTML = '';
  elements.form.querySelector('.dialog-head .eyebrow').textContent = 'NEW TRACK';
  elements.form.querySelector('.dialog-head h2').textContent = '添加账号环境';
}

function openProtocolDialog(account) {
  state.protocolDialogAccountId = account.id;
  state.protocolDialogPromptKind = '';
  elements.form.classList.add('protocol-progress-active');
  elements.protocolProgress.hidden = false;
  elements.form.querySelector('.dialog-head .eyebrow').textContent = 'PROTOCOL LOGIN';
  elements.form.querySelector('.dialog-head h2').textContent = '登录并授权';
  renderProtocolDialogProgress();
}

function renderProtocolDialogProgress() {
  if (!state.protocolDialogAccountId || !elements.dialog.open) return;
  const account = state.accounts.find((item) => item.id === state.protocolDialogAccountId);
  if (!account) return;
  const login = account.codexLogin;
  const completed = account.codexInitialized && !login;
  const failed = ['error', 'interrupted'].includes(login?.status);
  elements.protocolProgress.className = `protocol-dialog-progress${completed ? ' success' : failed ? ' error' : ''}`;
  elements.protocolProgressTitle.textContent = completed ? '账号已完成入池' : failed ? '登录授权未完成' : account.label;
  elements.protocolProgressCopy.textContent = completed
    ? '网页登录凭证与 Codex 授权已经写入独立账号环境。'
    : failed
      ? (login?.error || '登录进程已经结束，可以重新发起。')
      : login?.status === 'finalizing'
        ? (login.promptHint || '正在校验并写入 Codex 登录凭证。')
        : login?.promptKind
          ? '请在下方完成当前验证步骤，内容只传给本次登录进程。'
          : '后台正在推进 ChatGPT 网页登录与 Codex 授权，请稍候。';
  const nextPromptKind = String(login?.promptKind || '');
  if (state.protocolDialogPromptKind !== nextPromptKind) {
    state.protocolDialogPromptKind = nextPromptKind;
    elements.protocolProgressInput.innerHTML = nextPromptKind ? renderProtocolPrompt(login, 'protocol-modal-input') : '';
    elements.protocolProgressInput.querySelector('input')?.focus();
  }
  elements.protocolProgressCancel.hidden = completed;
  elements.protocolProgressRetry.hidden = !failed;
  elements.protocolProgressClose.hidden = !completed;
}

function showProtocolDialogConnectionError(message) {
  if (!state.protocolDialogAccountId || !elements.dialog.open) return false;
  const detail = String(message || '本地服务连接中断');
  elements.protocolProgress.className = 'protocol-dialog-progress error';
  elements.protocolProgressTitle.textContent = '后台服务连接中断';
  elements.protocolProgressCopy.textContent = `${detail}。Codex Navo 正在尝试恢复后台服务；关闭弹窗后可重新发起授权。`;
  elements.protocolProgressInput.innerHTML = '';
  elements.protocolProgressCancel.hidden = true;
  elements.protocolProgressRetry.hidden = true;
  elements.protocolProgressClose.hidden = false;
  showAccountDialogError(`后台服务连接中断：${detail}`);
  return true;
}

function hideToolsStatus() {
  clearTimeout(toolsStatusTimer);
  toolsStatusTimer = null;
  elements.toolsStatus.hidden = true;
  elements.toolsStatus.replaceChildren();
}

function showToolsStatus(message, error = false, autoHideMs = error ? 0 : 5_000) {
  clearTimeout(toolsStatusTimer);
  elements.toolsStatus.hidden = false;
  elements.toolsStatus.className = `tools-status${error ? ' error' : ' success'}`;
  const copy = document.createElement('span');
  copy.className = 'tools-status-copy';
  copy.textContent = message;
  const close = document.createElement('button');
  close.className = 'tools-status-close';
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', hideToolsStatus, { once: true });
  elements.toolsStatus.replaceChildren(copy, close);
  if (autoHideMs > 0) toolsStatusTimer = setTimeout(hideToolsStatus, autoHideMs);
}

function syncModalScrollLock() {
  const open = Boolean(document.querySelector('dialog[open]'));
  document.documentElement.classList.toggle('modal-open', open);
  document.body.classList.toggle('modal-open', open);
}

const modalObserver = new MutationObserver(syncModalScrollLock);
document.querySelectorAll('dialog').forEach((dialog) => modalObserver.observe(dialog, { attributes: true, attributeFilter: ['open'] }));

function setSortMenuOpen(open) {
  elements.sortPopover.hidden = !open;
  elements.sortTrigger.setAttribute('aria-expanded', String(open));
  elements.sortMenu.classList.toggle('open', open);
}

function syncSortMenu() {
  elements.sortLabel.textContent = sortLabels[state.sortMode] || sortLabels.current;
  elements.sortPopover.querySelectorAll('[data-sort]').forEach((button) => {
    const active = button.dataset.sort === state.sortMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', String(active));
  });
}

async function api(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(url, { ...options, headers });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('本地服务返回了无法识别的内容'); }
  if (!response.ok || !payload.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload.data;
}

function sessionDuration(task) {
  const started = Date.parse(task.startedAt || '');
  const ended = Date.parse(task.completedAt || '') || Date.now();
  const milliseconds = Number(task.durationMs || (Number.isFinite(started) ? ended - started : 0));
  if (!milliseconds || milliseconds < 0) return '—';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function sessionRelativeTime(value) {
  const elapsed = Date.now() - Date.parse(value || '');
  if (!Number.isFinite(elapsed) || elapsed < 0) return '刚刚';
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return `${Math.floor(elapsed / 86_400_000)} 天前`;
}

function renderSessions() {
  const snapshot = state.sessions || { tasks: [], counts: {} };
  const counts = snapshot.counts || {};
  elements.sessionRunningCount.textContent = counts.running || 0;
  elements.sessionWaitingCount.textContent = counts.waiting || 0;
  elements.sessionCompletedCount.textContent = counts.completedToday || 0;
  elements.sessionFailedCount.textContent = counts.failed || 0;
  elements.sessionTotalCount.textContent = counts.total || 0;
  elements.sessionFilters.querySelectorAll('[data-session-filter]').forEach((button) => {
    button.classList.toggle('active', button.dataset.sessionFilter === state.sessionFilter);
  });
  elements.sessionClearFailed.hidden = state.sessionFilter !== 'failed' || !(counts.failed > 0);
  const activeStatuses = new Set(['running', 'waiting_input', 'waiting_approval']);
  const failedStatuses = new Set(['failed', 'interrupted']);
  const tasks = (snapshot.tasks || []).filter((task) => state.sessionFilter === 'all'
    || (state.sessionFilter === 'active' && !task.archived && activeStatuses.has(task.status))
    || (state.sessionFilter === 'failed' && failedStatuses.has(task.status)));
  const renderCategory = (categoryTasks, archived) => {
    if (!categoryTasks.length) return '';
    const groups = new Map();
    for (const task of categoryTasks) {
      const key = task.cwd || task.project || 'unknown';
      if (!groups.has(key)) groups.set(key, { key: `${archived ? 'archived' : 'current'}:${key}`, label: task.project || '其他会话', cwd: task.cwd || '', tasks: [] });
      groups.get(key).tasks.push(task);
    }
    return `<section class="session-category ${archived ? 'archived' : 'current'}"><div class="session-category-head"><span>${archived ? '已归档' : '当前会话'}</span><small>${categoryTasks.length} 个会话</small></div>${[...groups.values()].map((group) => {
      if (state.sessionFilter === 'all' && !state.sessionAllSeenGroups.has(group.key)) {
        state.sessionAllSeenGroups.add(group.key);
        state.sessionCollapsed.add(group.key);
      }
      const collapsed = state.sessionCollapsed.has(group.key);
      return `<section class="session-project-group${collapsed ? ' collapsed' : ''}" data-session-group="${escapeHtml(group.key)}">
    <button class="session-project-head" type="button" data-session-project-toggle aria-expanded="${!collapsed}"><span class="session-project-icon" aria-hidden="true">⌂</span><span class="session-project-copy"><strong>${escapeHtml(group.label)}</strong><small>${escapeHtml(group.cwd || '未归类项目')}</small></span><em>${group.tasks.length} 个会话</em><i>⌃</i></button>
    <div class="session-project-rows">${group.tasks.map((task) => `
    <article class="session-row" data-session-id="${escapeHtml(task.id)}">
      <span class="session-thread-line" aria-hidden="true"><i></i></span><div class="session-title"><strong title="${escapeHtml(task.threadName || '未命名会话')}">${escapeHtml(task.threadName || '未命名会话')}</strong><small>${escapeHtml(task.originator || 'Codex')} · ${sessionRelativeTime(task.lastUpdatedAt)}</small></div>
      <div class="session-project"><b>${escapeHtml(task.model || '默认模型')}</b><small>模型</small></div>
      <div class="session-activity"><b title="${escapeHtml(task.currentActivity || '')}">${escapeHtml(task.currentActivity || '等待新任务')}</b><small>${sessionDuration(task)} · ${formatTokenCount(task.usage?.total || 0, true)} Token</small></div>
      <div class="session-row-actions"><span class="session-state-badge ${escapeHtml(task.status)}">${archived ? '已归档' : escapeHtml(task.statusLabel || task.status)}</span>${archived ? '' : `<button type="button" data-session-action="archive" title="归档会话">归档</button>`}<button class="danger" type="button" data-session-action="delete" title="删除会话">删除</button></div>
    </article>`).join('')}</div></section>`;
    }).join('')}</section>`;
  };
  const current = tasks.filter((task) => !task.archived);
  const archived = tasks.filter((task) => task.archived);
  elements.sessionList.innerHTML = tasks.length
    ? `${renderCategory(current, false)}${renderCategory(archived, true)}`
    : `<div class="session-empty">${state.sessionFilter === 'active' ? '当前没有正在运行或等待处理的会话' : state.sessionFilter === 'failed' ? '当前没有失败或中断的会话' : '还没有读取到本地 Codex 会话'}</div>`;
}

async function refreshSessions(showError = false) {
  try {
    state.sessions = await api('/api/sessions');
    renderSessions();
  } catch (error) {
    if (showError) showToast(error.message, true);
  }
}

function fillNotificationForm(settings = {}) {
  const form = elements.notificationForm;
  const customSounds = Array.isArray(settings.customSounds) ? settings.customSounds : [];
  form.elements.sound.querySelectorAll('option[data-custom-sound]').forEach((option) => option.remove());
  for (const sound of customSounds) {
    const option = document.createElement('option');
    option.value = sound.id;
    option.textContent = sound.name;
    option.dataset.customSound = 'true';
    form.elements.sound.add(option, form.elements.sound.querySelector('option[value="none"]'));
  }
  for (const name of ['enabled', 'systemNotification', 'notifyCompleted', 'notifyFailed', 'notifyWaiting', 'feishuEnabled', 'dingtalkEnabled', 'telegramEnabled']) {
    if (form.elements[name]) form.elements[name].checked = settings[name] !== false && (name.startsWith('notify') || name === 'enabled' || name === 'systemNotification')
      ? true
      : settings[name] === true;
  }
  for (const name of ['notificationText', 'sound', 'volume', 'feishuWebhook', 'dingtalkWebhook', 'telegramToken', 'telegramChatId']) {
    if (form.elements[name]) form.elements[name].value = settings[name] ?? '';
  }
  const activeCustom = customSounds.find((item) => item.id === form.elements.sound.value);
  elements.notificationSoundName.textContent = activeCustom?.name || '内置音效来自 Kenney Interface Sounds（CC0）；支持导入最大 5 MB 音频';
  elements.notificationVolumeValue.textContent = `${Math.round(Math.max(0, Math.min(1, Number(form.elements.volume.value) || 0)) * 100)}%`;
}

function notificationFormValue() {
  const form = elements.notificationForm;
  return {
    enabled: form.elements.enabled.checked,
    systemNotification: form.elements.systemNotification.checked,
    sound: form.elements.sound.value,
    customSounds: Array.isArray(state.notificationSettings.customSounds) ? state.notificationSettings.customSounds : [],
    volume: Number(form.elements.volume.value),
    notificationText: form.elements.notificationText.value,
    notifyCompleted: form.elements.notifyCompleted.checked,
    notifyFailed: form.elements.notifyFailed.checked,
    notifyWaiting: form.elements.notifyWaiting.checked,
    feishuEnabled: form.elements.feishuEnabled.checked,
    feishuWebhook: form.elements.feishuWebhook.value.trim(),
    dingtalkEnabled: form.elements.dingtalkEnabled.checked,
    dingtalkWebhook: form.elements.dingtalkWebhook.value.trim(),
    telegramEnabled: form.elements.telegramEnabled.checked,
    telegramToken: form.elements.telegramToken.value.trim(),
    telegramChatId: form.elements.telegramChatId.value.trim(),
  };
}

async function loadNotificationSettings() {
  try {
    state.notificationSettings = await api('/api/notification-settings');
    fillNotificationForm(state.notificationSettings);
  } catch {}
}

function playNotificationSound(sound, volume = 0.55) {
  if (sound === 'none') return;
  const custom = state.notificationSettings.customSounds?.find((item) => item.id === sound);
  if (custom?.dataUrl) {
    const audio = new Audio(custom.dataUrl); audio.volume = Math.max(0, Math.min(1, Number(volume))); audio.play().catch(() => {}); return;
  }
  const files = { 'soft-chime': 'confirmation_001.wav', 'bright-chime': 'confirmation_002.wav', glass: 'glass_001.wav', notice: 'bong_001.wav', question: 'question_001.wav', error: 'error_001.wav', pluck: 'pluck_001.wav', click: 'click_001.wav' };
  const audio = new Audio(`/sounds/kenney/${files[sound] || files['soft-chime']}`);
  audio.volume = Math.max(0, Math.min(1, Number(volume)));
  audio.play().catch(() => {});
}

async function presentNotification(item) {
  if (item.systemNotification) {
    if (window.codexNotifications?.show) await window.codexNotifications.show({ title: 'Codex Navo', body: item.message });
    else if ('Notification' in window && Notification.permission === 'granted') new Notification('Codex Navo', { body: item.message });
  }
  if (item.customSound) {
    const sounds = state.notificationSettings.customSounds ||= [];
    if (!sounds.some((sound) => sound.id === item.sound)) sounds.push({ id: item.sound, name: 'Imported sound', dataUrl: item.customSound });
  }
  playNotificationSound(item.sound, item.volume);
}

async function pollNotificationEvents() {
  try {
    const events = await api(`/api/notification-events?after=${state.notificationEventId}`);
    for (const item of events) {
      state.notificationEventId = Math.max(state.notificationEventId, Number(item.id || 0));
      await presentNotification(item);
    }
  } catch {}
}

function renderHealthCenter() {
  elements.healthList.innerHTML = state.accounts.length
    ? state.accounts.map((account) => {
      const health = account.health || { status: 'attention', label: '等待检查', detail: '尚未读取授权状态' };
      const action = ['needs_auth', 'expired', 'invalid', 'interrupted'].includes(health.status)
        ? `<button type="button" data-health-action="authorize" data-account-id="${account.id}">${health.status === 'interrupted' ? '继续' : '授权'}</button>`
        : `<button type="button" data-health-action="check" data-account-id="${account.id}">检查</button>`;
      return `<div class="health-row" data-health="${escapeHtml(health.status)}">
        <div class="health-account" title="${escapeHtml(account.label)}">${escapeHtml(account.label)}</div>
        <div class="health-state"><i></i>${escapeHtml(health.label)}</div>
        <div class="health-detail" title="${escapeHtml(health.detail)}">${escapeHtml(health.detail)}</div>
        ${action}
      </div>`;
    }).join('')
    : '<div class="health-empty">账号池为空，暂无可检查的授权。</div>';

  const selected = elements.exportAccount.value;
  elements.exportAccount.replaceChildren();
  for (const account of state.accounts.filter((item) => item.codexInitialized)) {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.label;
    elements.exportAccount.append(option);
  }
  if ([...elements.exportAccount.options].some((option) => option.value === selected)) elements.exportAccount.value = selected;
  elements.exportAuthPackage.disabled = !elements.exportAccount.value;
}

function downloadJsonFile(fileName, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function operator() {
  return '本机用户';
}

function formatReset(timestamp) {
  if (!timestamp) return '重置时间未知';
  const reset = new Date(timestamp * 1000);
  const remaining = Math.max(0, reset.getTime() - Date.now());
  const days = Math.floor(remaining / 86_400_000);
  const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  const dateText = reset.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return `${parts.join(' ')} (${dateText})`;
}

function quotaLabel(window) {
  return Number(window.windowDurationMins) >= 6 * 24 * 60 ? 'Weekly' : window.label;
}

function renderQuota(account) {
  if (account.quotaErrorCode === 'auth_expired') {
    return `<div class="quota-panel quota-unavailable quota-error"><div class="quota-empty-title">登录已失效</div><p>重新授权后会自动读取额度</p></div>`;
  }
  if (!account.codexInitialized) {
    return `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">等待登录授权</div><p>在独立浏览器完成官方流程后会自动入池</p></div>`;
  }
  if (!account.quota?.windows?.length) {
    return account.quotaError
      ? `<div class="quota-panel quota-unavailable quota-error-soft"><div class="quota-empty-title">额度刷新失败</div><p>${escapeHtml(account.quotaError)}，可点击右侧刷新按钮重试</p></div>`
      : `<div class="quota-panel quota-unavailable"><div class="quota-empty-title">正在读取额度</div><p>已入池账号会自动刷新</p></div>`;
  }
  const windows = account.quota.windows.slice(0, 2).map((window) => {
    const remaining = Math.max(0, Math.min(100, Number(window.remainingPercent) || 0));
    const tone = remaining >= 70 ? 'healthy' : remaining >= 30 ? 'warning' : 'critical';
    return `<div class="quota-window ${tone}">
      <div class="quota-line"><span>${escapeHtml(quotaLabel(window))}</span><strong>${remaining}%</strong></div>
      <progress class="quota-track" aria-label="${escapeHtml(quotaLabel(window))}可用额度" value="${remaining}" max="100">${remaining}%</progress>
      <div class="quota-reset">${escapeHtml(formatReset(window.resetsAt))}</div>
    </div>`;
  }).join('');
  const errorNotice = account.quotaError
    ? `<div class="quota-refresh-error"><span>刷新失败，当前显示上次数据</span><button data-action="quota" type="button">重试</button></div>`
    : '';
  return `<div class="quota-panel">${windows}${errorNotice}</div>`;
}

function renderApiService() {
  if (!elements.apiKeyList) return;
  const service = state.apiService || { providers: [], keys: [] };
  const accountPool = (service.providers || []).find((provider) => provider.type === 'navo-pool');
  const baseUrl = service.baseUrl || 'http://127.0.0.1:18300/v1';
  const defaultModel = accountPool?.defaultModel || accountPool?.models?.[0] || 'gpt-5.6-codex';
  elements.apiDocBaseUrl.textContent = baseUrl;
  elements.apiDocExample.textContent = `curl ${baseUrl}/responses \
  -H "Authorization: Bearer sk-navo-REPLACE_ME" \
  -H "Content-Type: application/json" \
  -d '{"model":"${defaultModel}","input":"Hello"}'`;
  const accountLabels = new Map(state.accounts.map((account) => [account.id, account.label]));
  elements.apiKeyList.innerHTML = service.keys?.length
    ? service.keys.map((key) => `<div class="api-service-row">
      <div class="api-service-row-main"><strong>${escapeHtml(key.name)}</strong><small>${escapeHtml(key.prefix)}</small></div>
      <div class="api-service-model">${key.enabled ? '已启用' : '已停用'}</div>
      <div class="api-service-meta"><span class="api-key-route">账号顺序：${key.accountIds?.length ? key.accountIds.map((id) => accountLabels.get(id) || '已移除账号').map(escapeHtml).join(' → ') : '全部可用账号（自动择优）'}</span><span>请求 ${Number(key.usage?.requests || 0)}${key.requestLimit ? ` / ${key.requestLimit}` : ''} · Token ${Number(key.usage?.inputTokens || 0) + Number(key.usage?.outputTokens || 0)}${key.tokenLimit ? ` / ${key.tokenLimit}` : ''}${key.expiresAt ? ` · 到期 ${escapeHtml(new Date(key.expiresAt).toLocaleDateString())}` : ''}</span></div>
      <div class="api-service-actions"><button type="button" data-api-key-edit="${key.id}">权限</button><button type="button" data-api-key-toggle="${key.id}">${key.enabled ? '停用' : '启用'}</button><button class="danger" type="button" data-api-key-delete="${key.id}">删除</button></div>
    </div>`).join('')
    : '<div class="api-service-empty">还没有 Navo API Key。完整 Key 只会在创建成功后显示一次。</div>';
}

function renderApiAccountCards() {
  const service = state.apiService || { keys: [] };
  return (service.keys || []).map((key) => {
    const active = service.activeKeyId === key.id;
    const usageExpanded = state.viewMode === 'grid' || state.expandedUsage.has(`api-key:${key.id}`);
    const remaining = Math.max(0, Math.min(100, Number(key.quota?.remainingPercent) || 0));
    const backing = key.backingAccounts || [];
    const apiProxyEnabled = key.network?.mode === 'proxy';
    return `<article class="account-card api-virtual-card${active ? ' current' : ''}${usageExpanded ? ' usage-expanded' : ''}" data-id="api-key:${key.id}" aria-expanded="${usageExpanded}">
      <div class="account-overview"><div class="account-identity"><div class="identity-title"><h3>${escapeHtml(key.name || 'Codex Navo API')}</h3></div><div class="identity-badges"><span class="plan-badge">API</span><span class="balance-badge">${backing.length} 个底层账号</span>${apiProxyEnabled ? `<span class="network-badge">代理 · ${escapeHtml(key.network.nodeName || '')}</span>` : ''}</div><p class="account-secondary">${escapeHtml(key.prefix || '')}</p></div></div>
      <div class="quota-panel"><div class="quota-window ${remaining >= 70 ? 'healthy' : remaining >= 30 ? 'warning' : 'critical'}"><div class="quota-line"><span>账号池可用额度</span><strong>${remaining}%</strong></div><progress class="quota-track" value="${remaining}" max="100">${remaining}%</progress><div class="quota-reset">按 ${backing.length} 个绑定账号的总额度平均计算</div></div></div>
      <div class="account-actions"><button class="action-primary ${active ? 'action-exit' : 'action-codex'}" data-action="api-codex-${active ? 'stop' : 'launch'}">${active ? '退出 Codex' : '登录 Codex'}</button><button class="action-primary" data-action="api-route">账号与顺序</button><button class="icon-action network-action" data-action="api-network" data-active="${apiProxyEnabled}" title="配置 API 账号池代理" aria-label="配置 API 账号池代理"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.4 5.2 3.4 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.6 8.7 8.6 12s1.2 6.2 3.4 8.5"></path></svg></button><button class="icon-action wake-action" data-action="api-wake" title="唤醒底层账号" aria-label="唤醒底层账号"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.8 5.8 13h5l-1 8.2L18.2 10h-5z"></path></svg></button><button class="icon-action" data-action="api-refresh" title="刷新额度">↻</button></div>
      ${usageExpanded ? renderUsageStrip(key.usage || {}) : ''}
    </article>`;
  }).join('');
}

function render() {
  renderProtocolDialogProgress();
  applyViewMode();
  renderUsage();
  renderApiService();
  const proxiedAccounts = state.accounts.filter((account) => account.network?.mode === 'proxy').length;
  elements.networkSettingsButton.dataset.tooltip = proxiedAccounts
    ? `${proxiedAccounts} 个账号使用代理`
    : '网络与节点';
  elements.networkSettingsButton.setAttribute('aria-pressed', String(proxiedAccounts > 0));
  const apiAccountCount = (state.apiService?.keys || []).length;
  const occupied = state.accounts.filter((account) => account.lease || account.codexActive).length + (state.apiService?.activeKeyId ? 1 : 0);
  elements.summary.innerHTML = `<span><strong>${state.accounts.length}</strong> 个账号${apiAccountCount ? ` · ${apiAccountCount} 个 Navo API` : ''}</span><i aria-hidden="true"></i><span class="${occupied ? 'has-active' : ''}"><strong>${occupied}</strong> 使用中</span>`;
  const activeAccount = state.accounts.find((account) => account.codexActive);
  const activeApiKey = (state.apiService?.keys || []).find((key) => key.id === state.apiService?.activeKeyId);
  const externalCodexRunning = Boolean(state.codexRunning && !activeAccount && !activeApiKey);
  elements.currentCodex.classList.toggle('active', Boolean(activeAccount));
  elements.currentCodex.classList.toggle('external', externalCodexRunning);
  elements.closeExternalCodex.hidden = !externalCodexRunning;
  elements.currentCodex.querySelector('span').textContent = activeAccount
    ? `当前 Codex · ${activeAccount.label}`
    : activeApiKey
      ? `当前 Codex · Navo API · ${activeApiKey.name}`
    : externalCodexRunning
      ? '外部 Codex 正在运行'
      : 'Codex 未启动';
  if (!state.accounts.length && !apiAccountCount) {
    elements.accounts.classList.add('is-empty');
    elements.accounts.innerHTML = `<div class="empty-state"><strong>暂无账号</strong><p>点击右上角“添加账号”创建第一个独立登录环境。</p></div>`;
    return;
  }

  elements.accounts.classList.remove('is-empty');

  const relayAccounts = state.accounts.filter((account) => account.accountKind === 'relay');
  const regularAccounts = state.accounts.filter((account) => account.accountKind !== 'relay');
  const renderAccountCards = (source) => sortedAccounts(activeAccount, source).map((account) => {
    const relayOnly = account.accountKind === 'relay';
    const status = account.enabled === false ? 'disabled' : account.lease || account.codexActive ? 'occupied' : 'free';
    const codexLoginPending = account.codexLogin && ['starting', 'waiting', 'finalizing'].includes(account.codexLogin.status);
    const setupSteps = !relayOnly && !account.codexInitialized ? `<div class="setup-steps one-step" aria-label="账号入池进度">
      <span class="active"><i>1</i>${account.setupStage === 'device-auth' ? '设备代码授权' : '登录并授权'}</span>
    </div>` : '';
    const codexLoginPanel = relayOnly ? '' : account.codexLogin ? `<div class="codex-login-panel ${['error', 'interrupted'].includes(account.codexLogin.status) ? 'error' : ''}">
      ${setupSteps}
      ${['error', 'interrupted'].includes(account.codexLogin.status)
        ? `<strong>${account.codexLogin.status === 'interrupted' ? '授权流程已中断' : '登录授权未完成'}</strong><span>${escapeHtml(account.codexLogin.error)}</span><div class="login-recovery-actions"><button class="login-fallback" data-action="authorize" type="button">继续授权</button>${account.codexLogin.status === 'error' ? '<button class="login-fallback" data-action="authorize-device" type="button">设备代码</button>' : ''}<button class="login-cancel" data-action="cancel-authorization" type="button">取消</button></div>`
        : account.codexLogin.flow === 'protocol'
        ? account.codexLogin.promptKind
            ? renderProtocolPrompt(account.codexLogin)
            : account.codexLogin.status === 'finalizing'
              ? '<strong>正在完成登录与授权</strong><small>正在写入独立 Chrome 网页会话和 Codex OAuth 凭证，请稍候。</small>'
              : '<strong>登录与 Codex 授权正在后台运行</strong><small>需要邮箱验证码、密码、两步验证、手机号或短信验证码时，会在这里显示输入框。</small>'
        : account.codexLogin.flow === 'device'
          ? `<strong>请在独立浏览器中完成设备代码授权</strong><span>设备验证码</span><code>${escapeHtml(account.codexLogin.userCode || '正在获取…')}</code><small>备用流程需要先在 ChatGPT 设置中开启设备代码授权。</small>`
          : `<strong>请在独立浏览器中完成登录与授权</strong><small>这是一个连续的官方流程，完成后会自动入池，无需开启设备代码授权。</small>`}
    </div>` : account.webLoginComplete && !account.codexInitialized ? `<div class="codex-login-panel setup-ready">
      ${setupSteps}
      <strong>网页端已登录并入池</strong>
      <small>该账号的独立 Chrome 会话已经验证；点击右侧按钮继续完成 Codex 授权。</small>
    </div>` : !account.codexInitialized ? `<div class="codex-login-panel setup-ready">
      ${setupSteps}
      <strong>登录授权尚未完成</strong>
      <small>点击“登录并授权”，在该账号的独立 Chrome 环境中一次完成官方流程。</small>
    </div>` : '';
    const secondaryIdentity = account.emailHint && account.emailHint !== account.label
      ? `<p>${escapeHtml(account.emailHint)}</p>`
      : '';
    const planType = account.quota?.planType;
    const planBadge = planType
      ? `<span class="plan-badge plan-${escapeHtml(String(planType).toLowerCase())}">${escapeHtml(formatPlan(planType))}</span>`
      : '';
    const creditText = formatCredits(account.quota?.credits);
    const creditBadge = creditText
      ? `<span class="credit-badge" title="Codex 返回的原始 Credits">${escapeHtml(creditText)}</span>`
      : '';
    const usdBalance = formatUsdBalance(account.quota?.credits);
    const balanceBadge = usdBalance
      ? `<span class="balance-badge" title="按 Codex 官方美国定价 US$0.04/Credit 换算">余额 ${escapeHtml(usdBalance)}</span>`
      : '';
    const browserOccupied = Boolean(account.lease && !account.codexActive && account.lease.launchType === 'browser');
    const sessionBadge = browserOccupied
      ? '<span class="session-badge"><i></i>网页使用中</span>'
      : '';
    const health = account.health || {};
    const healthBadge = health.status && health.status !== 'healthy'
      ? `<span class="health-badge health-${escapeHtml(health.status)}" title="${escapeHtml(health.detail || health.label)}">${escapeHtml(health.label || '待检查')}</span>`
      : '';
    const networkBadge = account.network?.mode === 'proxy'
      ? `<span class="network-badge" title="${escapeHtml(account.network.label)}">代理 · ${escapeHtml(account.network.nodeName)}</span>`
      : '';
    let codexAction;
    if (relayOnly) {
      codexAction = '<button class="action-primary action-blocked" type="button" disabled title="反代账号不会打开 Codex 桌面端">登录 Codex</button>';
    } else if (account.webLoginComplete && !account.codexInitialized) {
      codexAction = '<button class="action-primary action-codex" data-action="authorize">继续 Codex 授权</button>';
    } else if (!account.codexInitialized) {
      codexAction = `<button class="action-primary action-codex" data-action="authorize" ${codexLoginPending ? 'disabled' : ''}>${codexLoginPending ? '等待登录授权' : account.quotaErrorCode === 'auth_expired' ? '重新登录授权' : '登录并授权'}</button>`;
    } else if (account.codexActive) {
      codexAction = '<button class="action-primary action-exit" data-action="quit-codex">退出 Codex</button>';
    } else if (externalCodexRunning) {
      codexAction = '<button class="action-primary action-blocked" type="button" disabled title="请先通过顶部入口关闭外部 Codex">关闭后启动</button>';
    } else if (activeAccount) {
      codexAction = '<button class="action-primary action-blocked" type="button" disabled title="请先退出当前 Codex">暂不可切换</button>';
    } else {
      codexAction = '<button class="action-primary action-codex" data-action="codex">登录 Codex</button>';
    }
    const wakeTitle = account.wake?.running
      ? '正在唤醒账号'
      : account.wake?.lastWakeStatus === 'failed'
        ? `上次唤醒失败：${escapeHtml(account.wake.lastWakeError || '未知错误')}`
        : '唤醒账号（发送一次真实 Codex 请求）';
    const usageExpanded = state.viewMode === 'grid' || state.expandedUsage.has(account.id);
    const usageTitle = state.viewMode === 'grid' ? '卡片视图固定显示今日用量' : usageExpanded ? '点击卡片收起用量' : '点击卡片查看用量';
    return `<article class="account-card ${status}${relayOnly ? ' relay-account-card' : ''}${account.codexActive ? ' current' : ''}${usageExpanded ? ' usage-expanded' : ''}" data-id="${account.id}" aria-expanded="${usageExpanded}" title="${usageTitle}">
      <div class="account-overview">
        <div class="account-identity">
          <div class="identity-title"><h3>${escapeHtml(account.label)}</h3></div>
          ${(planBadge || creditBadge || balanceBadge || sessionBadge || healthBadge || networkBadge) ? `<div class="identity-badges">${planBadge}${creditBadge}${balanceBadge}${sessionBadge}${healthBadge}${networkBadge}</div>` : ''}
          ${secondaryIdentity}
        </div>
      </div>
      ${renderQuota(account)}
      <div class="account-actions">
        ${relayOnly
          ? '<button class="action-primary action-blocked" type="button" disabled title="反代账号不会创建网页环境">网页端</button>'
          : `<button class="action-primary ${browserOccupied ? 'action-browser-active' : ''}" data-action="browser">${browserOccupied ? '网页已打开' : account.codexInitialized ? '网页端' : '打开网页登录'}</button>`}
        ${codexAction}
        <button class="icon-action network-action" data-action="network" data-active="${account.network?.mode === 'proxy'}" title="${escapeHtml(account.network?.label || '配置账号网络')}" aria-label="配置账号网络"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M3.8 12h16.4M12 3.5c2.2 2.3 3.4 5.2 3.4 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.6 8.7 8.6 12s1.2 6.2 3.4 8.5"></path></svg></button>
        <button class="icon-action wake-action" data-action="wake" title="${wakeTitle}" aria-label="唤醒账号" ${account.codexInitialized && !account.wake?.running ? '' : 'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.2 2.8 5.8 13h5l-1 8.2L18.2 10h-5z"></path></svg></button>
        <button class="icon-action" data-action="quota" title="刷新额度" aria-label="刷新额度" ${account.codexInitialized ? '' : 'disabled'}>↻</button>
        ${account.lease && !account.codexActive ? '<button class="icon-action release-action" data-action="release" title="释放账号占用（不会关闭网页）" aria-label="释放账号占用"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="10" width="12" height="10" rx="2"></rect><path d="M9 10V7a3 3 0 0 1 5.6-1.5"></path></svg></button>' : '<button class="icon-action danger-button" data-action="remove" title="移除账号" aria-label="移除账号">×</button>'}
      </div>
      ${usageExpanded ? renderAccountUsage(account) : ''}
      ${codexLoginPanel}
    </article>`;
  }).join('');
  const regularCards = renderAccountCards(regularAccounts);
  const relayCards = renderAccountCards(relayAccounts);
  const apiCards = renderApiAccountCards();
  const groupHead = (kind, label, count) => `<button class="account-group-head" type="button" data-account-group="${kind}" aria-expanded="${!state.accountGroups[kind]}"><span>${escapeHtml(label)}</span><small>${count}</small><i>${state.accountGroups[kind] ? '＋' : '−'}</i></button>`;
  elements.accounts.innerHTML = `${apiAccountCount ? groupHead('api', 'API Codex', apiAccountCount) : ''}${state.accountGroups.api ? '' : apiCards}${relayAccounts.length ? groupHead('relay', '临时账号', relayAccounts.length) : ''}${state.accountGroups.relay ? '' : relayCards}${regularAccounts.length ? groupHead('regular', '普通账号', regularAccounts.length) : ''}${state.accountGroups.regular ? '' : regularCards}`;
  setLaunchControlsDisabled(state.launchProgress?.active === true);
}

function editingSurfaceActive() {
  const active = document.activeElement;
  return Boolean(
    document.querySelector('dialog[open]')
    || active?.matches?.('input, select, textarea, [contenteditable="true"]'),
  );
}

async function refresh(options = {}) {
  const background = options.background === true;
  try {
    const pendingAccountIds = new Set(state.accounts
      .filter((account) => !account.codexInitialized && account.setupStage !== 'complete')
      .map((account) => account.id));
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    if (elements.navoCurrentVersion && !applicationUpdate.currentVersion && state.appVersion) {
      elements.navoCurrentVersion.textContent = `v${state.appVersion}`;
    }
    if (state.usageRange !== 'today') state.usage = await api(`/api/usage?range=${encodeURIComponent(state.usageRange)}`);
    if (background && editingSurfaceActive()) return;
    render();
    const completed = state.accounts.find((account) => pendingAccountIds.has(account.id) && account.codexInitialized);
    if (completed) {
      showToast(completed.webLoginComplete
        ? '登录与授权已完成。ChatGPT 网页已打开，确认后可自行关闭浏览器窗口。'
        : 'Codex 授权已完成。网页端仍需登录时，可在该账号的独立 Chrome 中继续。');
    }
    refreshStaleQuotas({ background });
  } catch (error) {
    if (showProtocolDialogConnectionError(error.message)) return;
    elements.accounts.innerHTML = `<div class="empty-state"><strong>无法读取本地状态</strong><p>${escapeHtml(error.message)}。请确认启动窗口仍在运行，然后刷新页面。</p></div>`;
    showToast(error.message, true);
  }
}

async function refreshStaleQuotas(options = {}) {
  if (options.background && editingSurfaceActive()) return;
  if (state.quotaRefreshing) return;
  const now = Date.now();
  const due = state.accounts.filter((account) => {
    if (!account.codexInitialized) return false;
    if (!account.quota?.credits || creditQuantity(account.quota.credits) == null) return true;
    const interval = account.codexActive ? 60_000 : 5 * 60_000;
    const lastChecked = account.quota?.refreshedAt || account.quotaCheckedAt;
    return !lastChecked || Date.parse(lastChecked) <= now - interval;
  });
  if (!due.length) return;
  state.quotaRefreshing = true;
  try {
    for (const account of due) {
      try {
        await api(`/api/accounts/${account.id}/quota`, {
          method: 'POST',
          body: JSON.stringify({ operator: operator() }),
        });
      } catch {}
    }
    const data = await api('/api/bootstrap');
    Object.assign(state, data);
    if (!options.background || !editingSurfaceActive()) render();
  } finally {
    state.quotaRefreshing = false;
  }
}

elements.accounts.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.matches('.protocol-inline-input input')) {
    event.preventDefault();
    event.target.closest('.protocol-inline-input')?.querySelector('[data-action="protocol-input"]')?.click();
  }
});

elements.accounts.addEventListener('click', async (event) => {
  const groupButton = event.target.closest('[data-account-group]');
  if (groupButton) {
    const kind = groupButton.dataset.accountGroup;
    state.accountGroups[kind] = !state.accountGroups[kind];
    localStorage.setItem(accountGroupsStorageKey, JSON.stringify(state.accountGroups));
    render();
    return;
  }
  const button = event.target.closest('button[data-action]');
  const card = event.target.closest('[data-id]');
  if (!card) return;
  if (card.dataset.id.startsWith('api-key:')) {
    if (!button) {
      if (state.viewMode !== 'grid') {
        if (state.expandedUsage.has(card.dataset.id)) state.expandedUsage.delete(card.dataset.id); else state.expandedUsage.add(card.dataset.id);
        localStorage.setItem(expandedUsageStorageKey, JSON.stringify([...state.expandedUsage])); render();
      }
      return;
    }
    const keyId = card.dataset.id.slice('api-key:'.length);
    button.disabled = true;
    try {
      if (button.dataset.action === 'api-route') {
        const record = state.apiService.keys.find((item) => item.id === keyId);
        const result = await editApiKey(record);
        if (result) state.apiService = result.state;
      } else if (button.dataset.action === 'api-codex-launch' || button.dataset.action === 'api-codex-stop') {
        const stopping = button.dataset.action.endsWith('stop');
        const launchOptions = stopping ? null : await openCodexLaunchDialog();
        if (!stopping && !launchOptions) return;
        if (!stopping) beginLaunchUi('api', state.apiService.keys.find((item) => item.id === keyId)?.name || 'Navo API');
        state.apiService = await api(`/api/api-service/keys/${keyId}/${stopping ? 'stop' : 'launch'}`, {
          method: 'POST',
          body: JSON.stringify(stopping ? {} : { launchOptions }),
        });
      } else if (button.dataset.action === 'api-refresh') {
        state.apiService = await api(`/api/api-service/keys/${keyId}/refresh`, { method: 'POST', body: '{}' });
      } else if (button.dataset.action === 'api-wake') {
        state.apiService = await api(`/api/api-service/keys/${keyId}/wake`, { method: 'POST', body: '{}' });
        showToast('已唤醒该 API Key 的底层账号');
      } else if (button.dataset.action === 'api-network') {
        const record = state.apiService.keys.find((item) => item.id === keyId);
        if (!record) throw new Error('API Key 不存在');
        openApiKeyNetwork(record);
      }
      render();
    } catch (error) { showToast(error.message, true); }
    finally { button.disabled = false; }
    return;
  }
  if (!button) {
    if (event.target.closest('a, input, select, textarea, label')) return;
    if (state.viewMode === 'grid') return;
    if (state.expandedUsage.has(card.dataset.id)) state.expandedUsage.delete(card.dataset.id);
    else state.expandedUsage.add(card.dataset.id);
    localStorage.setItem(expandedUsageStorageKey, JSON.stringify([...state.expandedUsage]));
    render();
    return;
  }
  if (button.dataset.action === 'network') {
    const account = state.accounts.find((item) => item.id === card.dataset.id);
    if (account) openAccountNetwork(account);
    return;
  }
  button.disabled = true;
  try {
    const action = button.dataset.action;
    const currentOperator = operator();
    if (action === 'remove') {
      if (!confirm('只从列表移除这个账号。浏览器和 Codex 目录会保留，确定继续吗？')) return;
      await api(`/api/accounts/${card.dataset.id}`, { method: 'DELETE', body: JSON.stringify({ operator: currentOperator }) });
      showToast('已从列表移除，登录目录仍然保留');
    } else if (action === 'release') {
      await api(`/api/accounts/${card.dataset.id}/release`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('账号已释放');
    } else if (action === 'quota') {
      await api(`/api/accounts/${card.dataset.id}/quota`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('额度已刷新');
    } else if (action === 'wake') {
      await api(`/api/accounts/${card.dataset.id}/wake`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('账号已唤醒，额度状态已同步');
    } else if (action === 'cancel-authorization') {
      await api(`/api/accounts/${card.dataset.id}/cancel-authorization`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator }),
      });
      showToast('已取消未完成的授权流程');
    } else if (action === 'protocol-input') {
      const input = card.querySelector('.protocol-inline-input input');
      const value = String(input?.value || '').trim();
      if (!value) {
        showToast('请输入当前验证步骤需要的内容', true);
        return;
      }
      await api(`/api/accounts/${card.dataset.id}/protocol-input`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator, value }),
      });
      if (input) input.value = '';
      showToast('已提交，正在继续登录授权');
    } else if (action === 'authorize' || action === 'authorize-device') {
      if (action === 'authorize-device' && !confirm('设备代码是备用流程。请先在 ChatGPT 设置 → 账户安全与登录中开启“为 Codex 启用设备代码授权”。继续吗？')) return;
      await api(`/api/accounts/${card.dataset.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator }),
      });
      showToast(action === 'authorize-device'
          ? '已打开设备代码授权页，完成后账号会自动入池'
          : '已打开官方登录授权页，完成后账号会自动入池');
    } else if (action === 'quit-codex') {
      if (!confirm('退出当前 Codex？正在进行的任务会被中断。')) return;
      await api(`/api/accounts/${card.dataset.id}/quit-codex`, { method: 'POST', body: JSON.stringify({ operator: currentOperator }) });
      showToast('Codex 已退出，账号认证已安全保存');
    } else {
      const launchOptions = action === 'codex' ? await openCodexLaunchDialog() : null;
      if (action === 'codex' && !launchOptions) return;
      if (action === 'codex') beginLaunchUi('account', state.accounts.find((item) => item.id === card.dataset.id)?.label || 'Codex');
      const launched = await api(`/api/accounts/${card.dataset.id}/launch`, {
        method: 'POST',
        body: JSON.stringify({ operator: currentOperator, launchType: action, launchOptions }),
      });
      showToast(action === 'browser'
        ? '已打开独立环境；使用结束后关闭窗口，账号会自动释放'
        : launched.codexLogin
          ? '已打开该账号的独立授权页面'
          : '已切换账号并启动 Codex；关闭应用后账号会自动释放');
    }
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#add-account').addEventListener('click', () => {
  resetProtocolDialog();
  elements.form.reset();
  elements.accountDialogStatus.hidden = true;
  elements.accountDialogStatus.textContent = '';
  state.accountImportPackageText = '';
  elements.accountImportPackageFile.value = '';
  elements.accountImportFileName.textContent = '选择 .codexnavo 文件';
  populateAccountRouteSelect(elements.accountCreateRoute);
  syncAccountLoginMethod();
  elements.dialog.showModal();
  requestAnimationFrame(() => elements.form.querySelector('input[name="loginMethod"]:checked')?.focus());
});

elements.protocolProgressInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || !event.target.matches('.protocol-inline-input input')) return;
  event.preventDefault();
  elements.protocolProgressInput.querySelector('[data-action="protocol-modal-input"]')?.click();
});

elements.protocolProgressInput.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action="protocol-modal-input"]');
  if (!button || !state.protocolDialogAccountId) return;
  const input = elements.protocolProgressInput.querySelector('.protocol-inline-input input');
  const value = String(input?.value || '').trim();
  if (!value) return showAccountDialogError('请输入当前验证步骤需要的内容');
  button.disabled = true;
  try {
    await api(`/api/accounts/${state.protocolDialogAccountId}/protocol-input`, {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), value }),
    });
    if (input) input.value = '';
    state.protocolDialogPromptKind = '';
    elements.protocolProgressInput.innerHTML = '';
    elements.protocolProgressCopy.textContent = '已提交，正在继续登录授权。';
    await refresh();
  } catch (error) {
    showAccountDialogError(error.message);
  } finally {
    button.disabled = false;
  }
});

elements.protocolProgressCancel.addEventListener('click', async () => {
  if (state.protocolDialogAccountId) {
    try {
      await api(`/api/accounts/${state.protocolDialogAccountId}/cancel-authorization`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
    } catch {}
  }
  elements.dialog.close();
});

elements.protocolProgressRetry.addEventListener('click', async () => {
  if (!state.protocolDialogAccountId) return;
  elements.protocolProgressRetry.disabled = true;
  try {
    await api(`/api/accounts/${state.protocolDialogAccountId}/authorize`, {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    state.protocolDialogPromptKind = '';
    await refresh();
  } catch (error) {
    showAccountDialogError(error.message);
  } finally {
    elements.protocolProgressRetry.disabled = false;
  }
});

elements.protocolProgressClose.addEventListener('click', () => elements.dialog.close());
elements.dialog.addEventListener('close', resetProtocolDialog);

elements.accountToolsButton.addEventListener('click', () => {
  showAppPage('authorization');
  renderHealthCenter();
  hideToolsStatus();
});

elements.healthList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-health-action]');
  if (!button) return;
  const row = button.closest('.health-row');
  const originalText = button.textContent;
  button.disabled = true;
  row?.classList.add('is-checking');
  if (button.dataset.healthAction === 'check') {
    button.classList.add('is-loading');
    button.textContent = '检查中…';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    if (button.dataset.healthAction === 'authorize') {
      await api(`/api/accounts/${button.dataset.accountId}/authorize`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
      showToolsStatus('已继续官方登录授权流程，请在账号独立浏览器中完成操作。');
    } else {
      await api(`/api/accounts/${button.dataset.accountId}/health`, {
        method: 'POST', body: JSON.stringify({ operator: operator() }),
      });
      await refresh();
      const checked = state.accounts.find((account) => account.id === button.dataset.accountId);
      const health = checked?.health;
      const unhealthy = health?.status !== 'healthy';
      showToolsStatus(
        health
          ? `${checked.label}：${health.label}。${health.detail}`
          : '账号授权状态已检查，结果已更新。',
        unhealthy,
      );
    }
    if (button.dataset.healthAction === 'authorize') await refresh();
    renderHealthCenter();
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
    button.textContent = originalText;
    row?.classList.remove('is-checking');
  }
});

elements.checkAllHealth.addEventListener('click', async () => {
  elements.checkAllHealth.disabled = true;
  elements.checkAllHealth.textContent = '检查中…';
  try {
    await api('/api/accounts/health-all', {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    await refresh();
    renderHealthCenter();
    const unhealthy = state.accounts.filter((account) => account.health?.status !== 'healthy').length;
    showToolsStatus(unhealthy ? `检查完成：${unhealthy} 个账号需要处理。` : '检查完成：全部账号授权正常。', Boolean(unhealthy));
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.checkAllHealth.disabled = false;
    elements.checkAllHealth.textContent = '检查全部';
  }
});

elements.exportAuthPackage.addEventListener('click', async () => {
  elements.exportAuthPackage.disabled = true;
  try {
    const result = await api(`/api/accounts/${elements.exportAccount.value}/export-auth`, {
      method: 'POST', body: JSON.stringify({ operator: operator() }),
    });
    downloadJsonFile(result.fileName, result.package);
    showToolsStatus(result.webSessionIncluded
      ? '双端授权包已生成：包含 Codex 授权和网页会话。'
      : '授权包已生成，但该账号没有可导出的有效网页会话，因此仅包含 Codex 授权。');
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.exportAuthPackage.disabled = !elements.exportAccount.value;
  }
});

elements.importPackageFile.addEventListener('change', async () => {
  const file = elements.importPackageFile.files?.[0];
  state.importPackageText = '';
  try {
    state.importPackageText = await readAuthorizationPackageFile(file, {
      onName: (name) => { elements.importFileName.textContent = name; },
      onClear: () => { elements.importPackageFile.value = ''; },
    });
  } catch (error) {
    showToolsStatus(error.message, true);
  }
});

elements.accountImportPackageFile.addEventListener('change', async () => {
  const file = elements.accountImportPackageFile.files?.[0];
  state.accountImportPackageText = '';
  try {
    state.accountImportPackageText = await readAuthorizationPackageFile(file, {
      onName: (name) => { elements.accountImportFileName.textContent = name; },
      onClear: () => { elements.accountImportPackageFile.value = ''; },
    });
    elements.accountDialogStatus.hidden = true;
  } catch (error) {
    showAccountDialogError(error.message);
  }
});

elements.importAuthPackage.addEventListener('click', async () => {
  if (!state.importPackageText) return showToolsStatus('请先选择 .codexnavo 授权包', true);
  elements.importAuthPackage.disabled = true;
  try {
    const result = await api('/api/auth-packages/import', {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), package: state.importPackageText }),
    });
    state.importPackageText = '';
    elements.importPackageFile.value = '';
    elements.importFileName.textContent = '选择 .codexnavo 文件';
    await refresh();
    renderHealthCenter();
    const status = result.importStatus || {};
    showToolsStatus(status.web === 'imported'
      ? '导入完成：Codex 授权与网页会话均已验证。'
      : status.web === 'failed'
        ? `Codex 授权已导入；网页会话验证失败，需要重新登录网页端：${status.webError || '会话已失效'}`
        : 'Codex 授权已导入；该授权包不包含网页会话。', status.web === 'failed');
  } catch (error) {
    showToolsStatus(error.message, true);
  } finally {
    elements.importAuthPackage.disabled = false;
  }
});

elements.closeExternalCodex.addEventListener('click', async () => {
  if (!confirm('关闭外部 Codex？正在进行的任务会被中断。')) return;
  elements.closeExternalCodex.disabled = true;
  try {
    await api('/api/codex/quit-external', {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    });
    showToast('外部 Codex 已关闭');
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.closeExternalCodex.disabled = false;
  }
});
elements.floatingWindowButton?.addEventListener('click', async () => {
  try {
    const settings = await window.codexFloating?.getSettings();
    if (settings?.enabled) await window.codexFloating?.hide();
    else await window.codexFloating?.show();
  }
  catch (error) { showToast(error.message, true); }
});
function resetRelayImportDialog() {
  state.relayImportPackageText = '';
  elements.relayImportFile.value = '';
  elements.relayImportFileName.textContent = '尚未选择文件';
  elements.relayImportResult.hidden = true;
  elements.relayImportResult.className = 'api-result';
  elements.relayImportResult.textContent = '';
  elements.relayImportSubmit.disabled = true;
}

function openRelayImportDialog() {
  resetRelayImportDialog();
  elements.relayImportDialog.showModal();
}
elements.relayImportChoose?.addEventListener('click', () => elements.relayImportFile.click());
elements.relayImportClose?.addEventListener('click', () => elements.relayImportDialog.close());
elements.relayImportCancel?.addEventListener('click', () => elements.relayImportDialog.close());
elements.relayImportFile?.addEventListener('change', async () => {
  const file = elements.relayImportFile.files?.[0];
  state.relayImportPackageText = '';
  elements.relayImportSubmit.disabled = true;
  if (!file) return resetRelayImportDialog();
  elements.relayImportFileName.textContent = file.name;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('第三方数据包不能超过 2 MB');
    const text = await file.text();
    JSON.parse(text);
    state.relayImportPackageText = text;
    elements.relayImportResult.hidden = false;
    elements.relayImportResult.textContent = '文件已读取，导入时会自动识别格式并检查重复账号。';
    elements.relayImportSubmit.disabled = false;
  } catch (error) {
    elements.relayImportResult.hidden = false;
    elements.relayImportResult.className = 'api-result error';
    elements.relayImportResult.textContent = error instanceof SyntaxError ? '所选文件不是有效 JSON' : error.message;
  }
});
elements.relayImportForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.relayImportPackageText) return;
  elements.relayImportSubmit.disabled = true;
  elements.relayImportResult.hidden = false;
  elements.relayImportResult.className = 'api-result';
  elements.relayImportResult.textContent = '正在识别并导入临时账号…';
  try {
    const result = await api('/api/relay-accounts/import', {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), package: state.relayImportPackageText }),
    });
    elements.relayImportDialog.close();
    await refresh();
    showToast(`已导入 ${result.counts.total} 个临时账号（可续期 ${result.counts.refreshable}，限时 ${result.counts.temporary}）`);
  } catch (error) {
    elements.relayImportResult.className = 'api-result error';
    elements.relayImportResult.textContent = error.message;
    elements.relayImportSubmit.disabled = false;
  }
});
elements.refreshAllQuotas.addEventListener('click', async () => {
  const accounts = state.accounts.filter((account) => account.codexInitialized);
  if (!accounts.length) {
    showToast('暂无已完成授权的账号可刷新', true);
    return;
  }
  elements.refreshAllQuotas.disabled = true;
  elements.refreshAllQuotas.classList.add('loading');
  try {
    const results = await Promise.allSettled(accounts.map((account) => api(`/api/accounts/${account.id}/quota`, {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    })));
    const failed = results.filter((result) => result.status === 'rejected').length;
    await refresh();
    showToast(failed
      ? `已刷新 ${accounts.length - failed} 个账号，${failed} 个刷新失败`
      : `已刷新全部 ${accounts.length} 个账号额度`, Boolean(failed));
  } finally {
    elements.refreshAllQuotas.disabled = false;
    elements.refreshAllQuotas.classList.remove('loading');
  }
});
elements.wakeAll.addEventListener('click', async () => {
  const accounts = state.accounts.filter((account) => account.codexInitialized);
  if (!accounts.length) {
    showToast('暂无已完成授权的账号可唤醒', true);
    return;
  }
  if (!confirm(`将为 ${accounts.length} 个账号各发送一次真实 Codex 请求，会消耗额度。继续吗？`)) return;
  elements.wakeAll.disabled = true;
  elements.wakeAll.classList.add('loading');
  try {
    const result = await api('/api/wake-all', {
      method: 'POST',
      body: JSON.stringify({ operator: operator() }),
    });
    await refresh();
    const failed = result.total - result.succeeded;
    showToast(failed
      ? `已唤醒 ${result.succeeded} 个账号，${failed} 个失败`
      : `已成功唤醒全部 ${result.succeeded} 个账号`, Boolean(failed));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.wakeAll.disabled = false;
    elements.wakeAll.classList.remove('loading');
  }
});

function syncWakeForm() {
  const config = state.wakeSettings || {};
  elements.wakeForm.elements.enabled.checked = config.enabled === true;
  elements.wakeForm.elements.mode.value = config.mode || 'manual';
  elements.wakeForm.elements.dailyTime.value = config.dailyTime || '09:00';
  syncWakeModelOptions(config.model || '', config.reasoningEffort || '');
  elements.wakeForm.elements.prompt.value = config.prompt || 'hi';
  elements.wakeForm.querySelector('[data-daily-time]').hidden = elements.wakeForm.elements.mode.value !== 'daily';
}

const reasoningLabels = {
  none: '无推理', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultra: '极限（自动协作）',
};

function localizedReasoningLabel(effort) {
  const english = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
  return navoUsesChinese() ? (reasoningLabels[effort] || effort) : (english[effort] || effort);
}

function syncWakeReasoningOptions(preferred = '') {
  const modelSelect = elements.wakeForm.elements.model;
  const effortSelect = elements.wakeForm.elements.reasoningEffort;
  const selected = state.wakeModelOptions.find((model) => model.slug === modelSelect.value) || state.wakeModelOptions[0];
  effortSelect.replaceChildren();
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = selected?.defaultReasoningEffort
    ? (navoUsesChinese() ? `模型默认（${localizedReasoningLabel(selected.defaultReasoningEffort)}）` : `Model default (${localizedReasoningLabel(selected.defaultReasoningEffort)})`)
    : (navoUsesChinese() ? '模型默认' : 'Model default');
  effortSelect.append(defaultOption);
  for (const effort of selected?.reasoningEfforts || []) {
    const option = document.createElement('option');
    option.value = effort;
    option.textContent = localizedReasoningLabel(effort);
    effortSelect.append(option);
  }
  effortSelect.value = [...effortSelect.options].some((option) => option.value === preferred) ? preferred : '';
  elements.wakeModelHelp.textContent = selected
    ? (navoUsesChinese()
      ? `${selected.description || selected.displayName}；默认推理强度：${localizedReasoningLabel(selected.defaultReasoningEffort) || '由 Codex 决定'}`
      : `${selected.displayName || selected.slug}; default reasoning effort: ${localizedReasoningLabel(selected.defaultReasoningEffort) || 'Codex default'}`)
    : '模型列表暂不可用';
}

function syncWakeModelOptions(preferredModel = '', preferredEffort = '') {
  const select = elements.wakeForm.elements.model;
  select.replaceChildren();
  const currentDefault = state.wakeModelOptions[0];
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = currentDefault
    ? `Codex 默认（当前 ${currentDefault.displayName}）`
    : 'Codex 默认模型';
  select.append(defaultOption);
  for (const model of state.wakeModelOptions) {
    const option = document.createElement('option');
    option.value = model.slug;
    option.textContent = model.displayName;
    select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === preferredModel) ? preferredModel : '';
  syncWakeReasoningOptions(preferredEffort);
}

elements.wakeSettingsButton.addEventListener('click', () => {
  showAppPage('wake');
  syncWakeForm();
});

function showNetworkResult(message, error = false) {
  elements.networkResult.hidden = false;
  elements.networkResult.classList.toggle('error', error);
  elements.networkResult.textContent = message;
}

function nodeTestText(node) {
  if (!node.status || node.delay == null) return node.status === 'connection-failed' ? '连接失败' : '未检测';
  const labels = {
    available: '可用',
    'unsupported-region': '地区不支持',
    blocked: '站点拒绝',
    'rate-limited': '访问限流',
  };
  return `${node.delay} ms · ${labels[node.status] || '已检测'}`;
}

function nodeRouteText(node) {
  const states = {
    available: '可用',
    'unsupported-region': '地区不支持',
    blocked: '站点拒绝',
    'rate-limited': '访问限流',
    'connection-failed': '连接失败',
    checking: '检测中…',
  };
  if (node.delay != null) return `${node.delay} ms · ${states[node.status] || '已检测'}`;
  return states[node.status] || '未检测';
}

function renderNetworkSources() {
  const network = state.networkSettings || { core: {}, sources: [] };
  const sources = network.sources || [];
  if (!sources.some((source) => source.id === state.networkSourceId)) state.networkSourceId = sources[0]?.id || '';
  const selected = sources.find((source) => source.id === state.networkSourceId) || null;
  elements.networkCoreState.classList.toggle('ready', network.core?.installed === true);
  elements.networkCoreState.querySelector('span').textContent = network.core?.installed
    ? `内置 Mihomo ${network.core.version || ''} · 随应用更新`
    : '正在准备内置 Mihomo 代理核心';
  elements.networkSourceList.innerHTML = selected
    ? `<div class="network-workspace">
      <aside class="network-source-sidebar">
        <div class="network-sidebar-title"><span>线路来源</span><b>${sources.length}</b></div>
        <div class="network-source-tabs">${sources.map((source) => `<button class="network-source-tab${source.id === selected.id ? ' active' : ''}" type="button" data-source-id="${escapeHtml(source.id)}" data-network-action="select-source">
          <i></i><span><strong>${escapeHtml(source.name)}</strong><small>${source.nodes.length} 个节点 · ${source.kind === 'subscription' ? '订阅' : '独立节点'}</small></span>
        </button>`).join('')}</div>
      </aside>
      <section class="network-node-pane" data-source-id="${escapeHtml(selected.id)}">
        <header class="network-node-head">
          <div><strong>${escapeHtml(selected.name)}</strong><small title="${escapeHtml(selected.location)}">${escapeHtml(selected.location)}${selected.error ? ` · ${escapeHtml(selected.error)}` : ''}</small></div>
          <div class="network-source-actions"><button class="test-all-source" type="button" data-network-action="test-all"${selected.testing ? ' disabled aria-busy="true"' : ''}>${selected.testing ? `检测 ${selected.testing.completed} / ${selected.testing.total}` : '检测全部'}</button><button type="button" data-network-action="refresh">${selected.kind === 'subscription' ? '刷新订阅' : '重新识别'}</button><button class="remove-source" type="button" data-network-action="remove">删除</button></div>
        </header>
        <div class="network-node-columns"><span>节点</span><span>协议</span><span>ChatGPT 检测</span><span></span></div>
        <div class="network-node-list">${selected.nodes.length ? selected.nodes.map((node) => `<div class="network-node" data-node-name="${escapeHtml(node.name)}">
          <strong title="${escapeHtml(node.name)}">${escapeHtml(node.name)}</strong><span class="node-protocol">${escapeHtml(node.protocol)}</span><span class="node-delay ${escapeHtml(node.status || '')}">${escapeHtml(nodeTestText(node))}</span><button type="button" data-network-action="test">检测</button>
        </div>`).join('') : `<div class="network-empty"><strong>${selected.error ? '线路加载失败' : '还没有读取节点'}</strong><span>${selected.error ? escapeHtml(selected.error) : '点击右上角刷新，读取这个来源的节点列表。'}</span></div>`}</div>
      </section>
    </div>`
    : '<div class="network-empty">还没有节点或订阅</div>';
}

elements.networkSettingsButton.addEventListener('click', () => {
  showAppPage('network');
  elements.networkResult.hidden = true;
  renderNetworkSources();
});

elements.networkSourceForm.querySelectorAll('[data-network-input-label]').forEach((label) => {
  const control = label.querySelector('input, textarea');
  label.addEventListener('pointerdown', () => {
    requestAnimationFrame(() => {
      if (document.activeElement !== control) control.focus({ preventScroll: true });
    });
  });
  label.addEventListener('click', () => {
    if (document.activeElement !== control) control.focus({ preventScroll: true });
  });
});

elements.networkSourceForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const formData = new FormData(elements.networkSourceForm);
  elements.addNetworkSource.disabled = true;
  elements.addNetworkSource.textContent = '正在识别…';
  try {
    const result = await api('/api/network/sources', {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), name: formData.get('name'), input: formData.get('input') }),
    });
    state.networkSettings = result.networkSettings;
    state.networkSourceId = result.source.id;
    elements.networkSourceForm.elements.name.value = '';
    elements.networkSourceForm.elements.input.value = '';
    renderNetworkSources();
    showNetworkResult(result.warning || `已识别 ${result.source.nodes.length} 个节点`, Boolean(result.warning));
    render();
  } catch (error) {
    showNetworkResult(error.message, true);
  } finally {
    elements.addNetworkSource.disabled = false;
    elements.addNetworkSource.innerHTML = '<span>＋</span>添加';
  }
});

elements.networkSourceList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-network-action]');
  if (!button) return;
  const sourceElement = button.closest('[data-source-id]');
  const sourceId = sourceElement?.dataset.sourceId;
  const action = button.dataset.networkAction;
  if (action === 'select-source') {
    state.networkSourceId = sourceId;
    renderNetworkSources();
    return;
  }
  button.disabled = true;
  try {
    if (action === 'remove') {
      if (!confirm('删除该节点来源？使用它的账号会自动恢复为直连。')) return;
      state.networkSettings = await api(`/api/network/sources/${sourceId}`, { method: 'DELETE', body: JSON.stringify({ operator: operator() }) });
      showNetworkResult('节点来源已删除');
    } else if (action === 'refresh') {
      button.textContent = '刷新中…';
      const result = await api(`/api/network/sources/${sourceId}/refresh`, { method: 'POST', body: JSON.stringify({ operator: operator() }) });
      state.networkSettings = result.networkSettings;
      showNetworkResult(`已读取 ${result.source.nodes.length} 个节点`);
    } else if (action === 'test') {
      button.textContent = '检测中…';
      const nodeName = button.closest('[data-node-name]').dataset.nodeName;
      const result = await api(`/api/network/sources/${sourceId}/test`, { method: 'POST', body: JSON.stringify({ operator: operator(), nodeName }) });
      state.networkSettings = result.networkSettings;
      showNetworkResult(`${result.message}${result.latencyMs == null ? '' : ` · ${result.latencyMs} ms`}`, !result.ok);
    } else if (action === 'test-all') {
      button.textContent = '检测中…';
      let polling = false;
      const progressTimer = setInterval(async () => {
        if (polling) return;
        polling = true;
        try {
          state.networkSettings = await api('/api/network-state');
          renderNetworkSources();
        } catch {} finally { polling = false; }
      }, 350);
      try {
        const result = await api(`/api/network/sources/${sourceId}/test-all`, { method: 'POST', body: JSON.stringify({ operator: operator() }) });
        state.networkSettings = result.networkSettings;
        showNetworkResult(`检测完成：可用 ${result.available}，地区不支持 ${result.unsupported}，失败 ${result.failed}`);
      } finally {
        clearInterval(progressTimer);
      }
    }
    renderNetworkSources();
    render();
  } catch (error) {
    showNetworkResult(error.message, true);
  } finally {
    button.disabled = false;
  }
});

function accountRouteValue(sourceId, nodeName) {
  return `${sourceId}|${encodeURIComponent(nodeName)}`;
}

function populateAccountRouteSelect(select, selectedValue = 'direct') {
  select.replaceChildren(new Option('直连', 'direct'));
  for (const source of state.networkSettings?.sources || []) {
    if (!source.nodes?.length) continue;
    const group = document.createElement('optgroup');
    group.label = source.name;
    for (const node of source.nodes) {
      group.append(new Option(`${node.name}  ·  ${node.protocol}  ·  ${nodeRouteText(node)}`, accountRouteValue(source.id, node.name)));
    }
    select.append(group);
  }
  select.value = selectedValue;
  if (!select.value) select.value = 'direct';
}

function syncAccountNetworkPreview() {
  const value = elements.accountNetworkRoute.value;
  const option = elements.accountNetworkRoute.selectedOptions[0];
  const direct = value === 'direct';
  elements.testAccountNetwork.disabled = direct;
  elements.accountNetworkPreview.classList.toggle('active', !direct);
  elements.accountNetworkPreview.querySelector('strong').textContent = direct ? '直连' : option.textContent;
  const apiPool = state.accountNetworkId.startsWith('api-key:');
  elements.accountNetworkPreview.querySelector('small').textContent = direct
    ? (apiPool ? '该 API Key 的账号池请求全部直连' : '网页端和 Codex 均不使用代理')
    : (apiPool ? '该 API Key 绑定的全部账号统一使用此节点' : '网页端、授权、额度与 Codex 使用此节点');
}

function openAccountNetwork(account) {
  state.accountNetworkId = account.id;
  elements.accountNetworkCopy.textContent = `为 ${account.label} 选择独立线路。`;
  populateAccountRouteSelect(elements.accountNetworkRoute);
  const proxyNodeCount = (state.networkSettings?.sources || []).reduce((total, source) => total + (source.nodes?.length || 0), 0);
  elements.accountNetworkRoute.value = account.network?.mode === 'proxy'
    ? accountRouteValue(account.network.sourceId, account.network.nodeName)
    : 'direct';
  if (!elements.accountNetworkRoute.value) elements.accountNetworkRoute.value = 'direct';
  const noNodes = proxyNodeCount === 0;
  elements.accountNetworkRoute.closest('label').hidden = noNodes;
  elements.accountNetworkPreview.hidden = noNodes;
  elements.accountNetworkEmpty.hidden = !noNodes;
  elements.saveAccountNetwork.hidden = noNodes;
  elements.accountNetworkResult.hidden = true;
  syncAccountNetworkPreview();
  elements.accountNetworkDialog.showModal();
}

function openApiKeyNetwork(key) {
  state.accountNetworkId = `api-key:${key.id}`;
  elements.accountNetworkCopy.textContent = `为 ${key.name} 选择账号池统一线路。绑定到该 Key 的账号发起 API 请求时都会使用这条线路。`;
  populateAccountRouteSelect(elements.accountNetworkRoute);
  const proxyNodeCount = (state.networkSettings?.sources || []).reduce((total, source) => total + (source.nodes?.length || 0), 0);
  elements.accountNetworkRoute.value = key.network?.mode === 'proxy'
    ? accountRouteValue(key.network.sourceId, key.network.nodeName)
    : 'direct';
  if (!elements.accountNetworkRoute.value) elements.accountNetworkRoute.value = 'direct';
  const noNodes = proxyNodeCount === 0;
  elements.accountNetworkRoute.closest('label').hidden = noNodes;
  elements.accountNetworkPreview.hidden = noNodes;
  elements.accountNetworkEmpty.hidden = !noNodes;
  elements.saveAccountNetwork.hidden = noNodes;
  elements.accountNetworkResult.hidden = true;
  syncAccountNetworkPreview();
  elements.accountNetworkDialog.showModal();
}

elements.accountNetworkRoute.addEventListener('change', syncAccountNetworkPreview);
elements.testAccountNetwork.addEventListener('click', async () => {
  const route = elements.accountNetworkRoute.value;
  if (!route || route === 'direct') return;
  const [sourceId, encodedNode = ''] = route.split('|');
  const nodeName = decodeURIComponent(encodedNode);
  elements.testAccountNetwork.disabled = true;
  elements.testAccountNetwork.textContent = '检测中…';
  elements.accountNetworkResult.hidden = false;
  elements.accountNetworkResult.classList.remove('error');
  elements.accountNetworkResult.textContent = '正在通过所选线路连接 ChatGPT…';
  try {
    const result = await api(`/api/network/sources/${sourceId}/test`, {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), nodeName }),
    });
    state.networkSettings = result.networkSettings;
    populateAccountRouteSelect(elements.accountNetworkRoute, route);
    syncAccountNetworkPreview();
    elements.accountNetworkResult.classList.toggle('error', !result.ok);
    elements.accountNetworkResult.textContent = `${result.message}${result.latencyMs == null ? '' : ` · ${result.latencyMs} ms`}`;
  } catch (error) {
    elements.accountNetworkResult.classList.add('error');
    elements.accountNetworkResult.textContent = error.message;
  } finally {
    elements.testAccountNetwork.textContent = '检测当前线路';
    elements.testAccountNetwork.disabled = elements.accountNetworkRoute.value === 'direct';
  }
});
elements.manageAccountNetwork.addEventListener('click', () => {
  elements.accountNetworkDialog.close();
  elements.networkResult.hidden = true;
  renderNetworkSources();
  showAppPage('network');
});
elements.accountNetworkForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const route = elements.accountNetworkRoute.value;
  const [sourceId, encodedNode = ''] = route.split('|');
  elements.saveAccountNetwork.disabled = true;
  try {
    const apiKeyId = state.accountNetworkId.startsWith('api-key:') ? state.accountNetworkId.slice(8) : '';
    const endpoint = apiKeyId ? `/api/api-service/keys/${apiKeyId}/network` : `/api/accounts/${state.accountNetworkId}/network`;
    const result = await api(endpoint, {
      method: 'POST',
      body: JSON.stringify({ operator: operator(), mode: route === 'direct' ? 'direct' : 'proxy', sourceId, nodeName: decodeURIComponent(encodedNode) }),
    });
    state.networkSettings = result.networkSettings;
    elements.accountNetworkDialog.close();
    await refresh();
    showToast(route === 'direct' ? (apiKeyId ? 'API 账号池已切换为直连' : '该账号已切换为直连') : (apiKeyId ? 'API 账号池代理已保存' : '账号代理已保存'));
  } catch (error) {
    elements.accountNetworkResult.hidden = false;
    elements.accountNetworkResult.classList.add('error');
    elements.accountNetworkResult.textContent = error.message;
  } finally {
    elements.saveAccountNetwork.disabled = false;
  }
});
elements.wakeForm.elements.mode.addEventListener('change', syncWakeFormVisibility);
elements.wakeForm.elements.model.addEventListener('change', () => syncWakeReasoningOptions(''));
function syncWakeFormVisibility() {
  elements.wakeForm.querySelector('[data-daily-time]').hidden = elements.wakeForm.elements.mode.value !== 'daily';
}
elements.wakeForm.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const formData = new FormData(elements.wakeForm);
  try {
    state.wakeSettings = await api('/api/wake-settings', {
      method: 'POST',
      body: JSON.stringify({
        enabled: formData.get('enabled') === 'on',
        mode: formData.get('mode'),
        dailyTime: formData.get('dailyTime'),
        model: formData.get('model'),
        reasoningEffort: formData.get('reasoningEffort'),
        prompt: formData.get('prompt'),
      }),
    });
    showToast(state.wakeSettings.enabled ? '自动唤醒设置已启用' : '唤醒设置已保存');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.sortTrigger.addEventListener('click', () => {
  setSortMenuOpen(elements.sortPopover.hidden);
});
elements.viewSwitcher.addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (!button || button.dataset.view === state.viewMode) return;
  state.viewMode = button.dataset.view;
  localStorage.setItem(viewStorageKey, state.viewMode);
  render();
});

elements.usageRange.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-range]');
  if (!button || button.dataset.range === state.usageRange) return;
  const previous = state.usageRange;
  state.usageRange = button.dataset.range;
  localStorage.setItem(usageRangeStorageKey, state.usageRange);
  renderUsage();
  elements.usageRange.querySelectorAll('button').forEach((item) => { item.disabled = true; });
  try {
    state.usage = await api(`/api/usage?range=${encodeURIComponent(state.usageRange)}`);
    render();
  } catch (error) {
    state.usageRange = previous;
    localStorage.setItem(usageRangeStorageKey, previous);
    renderUsage();
    showToast(error.message, true);
  } finally {
    elements.usageRange.querySelectorAll('button').forEach((item) => { item.disabled = false; });
  }
});
elements.sortPopover.addEventListener('click', (event) => {
  const option = event.target.closest('[data-sort]');
  if (!option) return;
  state.sortMode = option.dataset.sort;
  localStorage.setItem(sortStorageKey, state.sortMode);
  syncSortMenu();
  setSortMenuOpen(false);
  render();
});
document.addEventListener('click', (event) => {
  if (!elements.sortMenu.contains(event.target)) setSortMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.sortPopover.hidden) {
    setSortMenuOpen(false);
    elements.sortTrigger.focus();
  }
});

async function openApplicationSettings() {
  showAppPage('language');
  loadLanguageSettings();
  refreshCodexUpdateState();
  if (!window.codexUpdater) return;
  if (['available', 'downloading', 'downloaded', 'error', 'development'].includes(applicationUpdate.status)) return;
  applicationUpdate = await window.codexUpdater.check();
  renderApplicationUpdate();
}

async function refreshCodexUpdateState() {
  if (!window.codexUpdater?.getCodexState) {
    elements.codexUpdateCopy.textContent = '请在 Microsoft Store 中检查 Codex 更新。';
    return;
  }
  elements.codexUpdateAction.disabled = true;
  elements.codexUpdateCopy.textContent = '正在读取已安装版本…';
  try {
    const info = await window.codexUpdater.getCodexState();
    elements.codexCurrentVersion.textContent = info.installed ? `v${info.version}` : '未安装';
    elements.codexUpdateCopy.textContent = info.installed
      ? '已读取本机安装版本。点击“检查并更新”，Navo 会在后台完成官方版本更新。'
      : '本机没有检测到 Codex 桌面应用，点击“检查并更新”可直接安装。';
  } catch (error) {
    elements.codexUpdateCopy.textContent = error.message || '读取 Codex 版本失败。';
  } finally {
    elements.codexUpdateAction.disabled = false;
  }
}

async function installCodexUpdate() {
  if (!window.codexUpdater?.installCodexUpdate) return refreshCodexUpdateState();
  elements.codexUpdateAction.disabled = true;
  elements.codexUpdateAction.textContent = '正在更新…';
  elements.codexUpdateCopy.textContent = '正在通过 Windows 包管理器检查并安装 Codex 更新，请不要关闭 Navo。';
  try {
    const info = await window.codexUpdater.installCodexUpdate();
    elements.codexCurrentVersion.textContent = info.version ? `v${info.version}` : '未安装';
    elements.codexUpdateCopy.textContent = info.message || (info.updated ? 'Codex 已更新到最新版。' : 'Codex 已是最新版。');
  } catch (error) {
    elements.codexUpdateCopy.textContent = error.message || 'Codex 更新失败，请尝试从 Microsoft Store 更新。';
  } finally {
    elements.codexUpdateAction.disabled = false;
    elements.codexUpdateAction.textContent = '检查并更新';
  }
}

async function performApplicationUpdateAction(button = elements.updatePrimaryAction) {
  if (!window.codexUpdater) return;
  const action = button?.dataset.action || 'check';
  if (action === 'download') applicationUpdate = await window.codexUpdater.download();
  else if (action === 'install') {
    await window.codexUpdater.install();
    return;
  } else applicationUpdate = await window.codexUpdater.check();
  renderApplicationUpdate();
}

elements.updateChip.addEventListener('click', openApplicationSettings);
elements.sidebarAccountButton.addEventListener('click', () => {
  showAppPage('accounts');
});
elements.sidebarToggle.addEventListener('click', () => {
  const collapsed = !elements.appWorkspace.classList.contains('sidebar-collapsed');
  localStorage.setItem(sidebarStorageKey, String(collapsed));
  syncSidebar(collapsed);
});

document.querySelectorAll('[data-sidebar-section]').forEach((button) => {
  button.addEventListener('click', () => {
    showAppPage(button.dataset.sidebarSection);
    if (button.dataset.sidebarSection === 'sessions') refreshSessions(true);
    if (button.dataset.sidebarSection === 'notifications') loadNotificationSettings();
    if (button.dataset.sidebarSection === 'language') {
      loadLanguageSettings();
      refreshCodexUpdateState();
    }
  });
});

elements.sessionRefresh.addEventListener('click', async () => {
  elements.sessionRefresh.disabled = true;
  try { await refreshSessions(true); } finally { elements.sessionRefresh.disabled = false; }
});

elements.sessionFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-session-filter]');
  if (!button) return;
  state.sessionFilter = button.dataset.sessionFilter;
  renderSessions();
});
elements.sessionClearFailed.addEventListener('click', async () => {
  const values = await openApiFormDialog({
    eyebrow: 'SESSION CLEANUP',
    title: '清空失败或中断会话',
    copy: '选择只从 Navo 会话列表隐藏，或同时删除 Codex 本地会话文件与索引记录。',
    submitLabel: '确认清空',
    fields: [{
      name: 'mode', label: '清空方式', type: 'select', value: 'list',
      options: [
        { value: 'list', label: '仅清空列表（保留本地数据）' },
        { value: 'delete', label: '清空列表和本地数据' },
      ],
      help: '仅清空列表可以保留 Codex 原始会话；删除本地数据后会从 Codex 中一并移除。',
    }],
  });
  if (!values) return;
  if (values.mode === 'delete' && !await openApiConfirmDialog('失败或中断的会话文件和索引记录将被永久删除。', '确认删除本地数据？')) return;
  elements.sessionClearFailed.disabled = true;
  try {
    state.sessions = await api('/api/sessions/failed/clear', { method: 'POST', body: JSON.stringify({ mode: values.mode }) });
    renderSessions();
    showToast(values.mode === 'delete' ? '失败会话及本地数据已清空' : '失败会话已从列表清空');
  } catch (error) { showToast(error.message, true); }
  finally { elements.sessionClearFailed.disabled = false; }
});
elements.sessionList.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-session-action]');
  if (action) {
    const row = action.closest('[data-session-id]');
    const operation = action.dataset.sessionAction;
    const prompt = operation === 'delete' ? '永久删除这个会话？该操作会同时移除 Codex 会话文件和索引记录。' : '将这个会话移入“已归档”？';
    if (!await openApiConfirmDialog(prompt, operation === 'delete' ? '删除会话？' : '归档会话？')) return;
    action.disabled = true;
    try {
      state.sessions = await api(`/api/sessions/${row.dataset.sessionId}/${operation}`, { method: 'POST', body: '{}' });
      renderSessions();
      showToast(operation === 'delete' ? '会话已删除' : '会话已归档');
    } catch (error) { showToast(error.message, true); }
    return;
  }
  const button = event.target.closest('[data-session-project-toggle]');
  if (!button) return;
  const group = button.closest('.session-project-group');
  const key = group.dataset.sessionGroup;
  if (state.sessionCollapsed.has(key)) state.sessionCollapsed.delete(key); else state.sessionCollapsed.add(key);
  renderSessions();
});

elements.notificationSoundImport.addEventListener('click', async () => {
  try {
    const selected = await window.codexNotifications?.importSound?.();
    if (!selected) return;
    const sounds = Array.isArray(state.notificationSettings.customSounds) ? [...state.notificationSettings.customSounds] : [];
    const index = sounds.findIndex((item) => item.id === selected.id);
    if (index >= 0) sounds[index] = selected; else sounds.push(selected);
    state.notificationSettings.customSounds = sounds.slice(-20);
    state.notificationSettings.sound = selected.id;
    fillNotificationForm(state.notificationSettings);
    elements.notificationSoundName.textContent = selected.name;
    playNotificationSound(selected.id, elements.notificationForm.elements.volume.value);
  } catch (error) { showToast(error.message, true); }
});

elements.notificationForm.elements.sound.addEventListener('change', () => {
  const selected = state.notificationSettings.customSounds?.find((item) => item.id === elements.notificationForm.elements.sound.value);
  elements.notificationSoundName.textContent = selected?.name || '内置音效来自 Kenney Interface Sounds（CC0）；支持导入最大 5 MB 音频';
});
elements.notificationForm.elements.volume.addEventListener('input', () => {
  elements.notificationVolumeValue.textContent = `${Math.round(Number(elements.notificationForm.elements.volume.value) * 100)}%`;
});

async function loadLanguageSettings() {
  try {
    const catalog = state.localeCatalog || await api('/api/codex-launch-options');
    state.localeCatalog = catalog;
    elements.appLanguageSelect.innerHTML = catalog.languages.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join('');
    elements.appLanguageSelect.value = catalog.languages.some((item) => item.id === state.appLocale) ? state.appLocale : catalog.defaultLanguage;
  elements.languageStatus.textContent = navoUsesChinese() ? '当前使用完整简体中文界面。' : 'Navo is using the English interface. Codex will use the selected language.';
  } catch (error) { showToast(error.message, true); }
}
elements.languageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  state.appLocale = elements.appLanguageSelect.value;
  localStorage.setItem(localeStorageKey, state.appLocale);
  document.documentElement.lang = state.appLocale;
  window.codexFloating?.updateLocale?.(state.appLocale);
  elements.languageStatus.textContent = navoUsesChinese() ? '已保存。Navo 与 Codex 默认使用简体中文。' : 'Saved. Navo is using English and Codex will use the selected language.';
  showToast('语言设置已保存');
  if (!navoUsesChinese()) translateUi();
  else window.location.reload();
});

elements.notificationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    state.notificationSettings = await api('/api/notification-settings', { method: 'POST', body: JSON.stringify(notificationFormValue()) });
    fillNotificationForm(state.notificationSettings);
    showToast('通知设置已保存');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.notificationTestLocal.addEventListener('click', async () => {
  elements.notificationTestLocal.disabled = true;
  try {
    await api('/api/notifications/test-local', { method: 'POST', body: JSON.stringify(notificationFormValue()) });
    await pollNotificationEvents();
    showToast('测试提醒已发送');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    elements.notificationTestLocal.disabled = false;
  }
});

elements.notificationForm.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-test-channel]');
  if (!button) return;
  const channel = button.dataset.testChannel;
  const result = elements.notificationForm.querySelector(`[data-channel-result="${channel}"]`);
  button.disabled = true;
  result.className = '';
  result.textContent = '正在连接…';
  try {
    await api('/api/notifications/test-channel', { method: 'POST', body: JSON.stringify({ channel, settings: notificationFormValue() }) });
    result.className = 'success';
    result.textContent = '连接成功，测试消息已发送';
  } catch (error) {
    result.className = 'error';
    result.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector('.api-docs-panel')?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-api-copy]');
  if (!button) return;
  const kind = button.dataset.apiCopy;
  const value = kind === 'base-url'
    ? elements.apiDocBaseUrl.textContent
    : kind === 'authorization'
      ? 'Authorization: Bearer sk-navo-REPLACE_ME'
      : elements.apiDocExample.textContent;
  try {
    await navigator.clipboard.writeText(value);
    showToast('已复制到剪贴板');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('已复制到剪贴板');
  }
});

async function editApiKey(record = null) {
  const accountPool = (state.apiService.providers || []).find((provider) => provider.type === 'navo-pool');
  if (!accountPool) throw new Error('账号池 API 尚未就绪');
  const values = await openApiFormDialog({
    eyebrow: record ? 'KEY PERMISSIONS' : 'NEW ACCESS KEY',
    title: record ? '编辑 Key 权限' : '创建 Navo API Key',
    copy: record ? '修改模型范围、请求额度、Token 额度和有效期。' : '完整 Key 只会在创建成功后显示一次，请及时复制保存。',
    submitLabel: record ? '保存权限' : '创建 Key',
    fields: [
      { name: 'name', label: 'Key 名称', value: record?.name || 'Codex Navo Key', required: true },
      { name: 'accountIds', type: 'hidden', value: (record?.accountIds || []).join(',') },
      { name: 'models', label: '允许的模型', value: (record?.modelAllowlist || []).map((model) => model.split('/').slice(-1)[0]).join(','), placeholder: '留空表示允许全部账号池模型' },
      { name: 'requestLimit', label: '请求上限', type: 'number', min: 0, value: record?.requestLimit || 0, help: '0 表示不限。' },
      { name: 'tokenLimit', label: 'Token 上限', type: 'number', min: 0, value: record?.tokenLimit || 0, help: '0 表示不限。' },
      { name: 'expiresAt', label: '到期时间', type: 'datetime-local', value: record?.expiresAt ? String(record.expiresAt).slice(0, 16) : '', help: '留空表示永不过期。' },
    ],
    onReady: ({ form }) => {
      mountAccountPoolPicker({
        form,
        accounts: state.accounts.filter((account) => account.codexInitialized),
        selectedIds: record?.accountIds || [],
      });
      mountModelPicker({
        form,
        buttonLabel: '检测账号池模型',
        loadModels: async () => {
          const accountIds = String(form.elements.accountIds.value || '').split(',').map((id) => id.trim()).filter(Boolean);
          const models = await api('/api/api-service/models/detect', {
            method: 'POST',
            body: JSON.stringify({ accountIds }),
          });
          return models.map((model) => ({
            value: model.id,
            label: `${model.label || model.id} · ${model.supportedAccounts}/${model.totalAccounts} 个账号支持`,
          }));
        },
      });
    },
  });
  if (!values) return null;
  const payload = {
    name: values.name.trim(),
    providerIds: [accountPool.id],
    accountIds: String(values.accountIds || '').split(',').map((id) => id.trim()).filter(Boolean),
    showInAccounts: true,
    modelAllowlist: parseModelList(values.models).map((model) => model.split('/').slice(-1)[0]),
    requestLimit: Number.parseInt(values.requestLimit, 10) || 0,
    tokenLimit: Number.parseInt(values.tokenLimit, 10) || 0,
    expiresAt: values.expiresAt ? new Date(values.expiresAt).toISOString() : null,
  };
  if (!payload.accountIds.length) throw new Error('请至少选择一个普通账号或临时账号');
  if (record) return api(`/api/api-service/keys/${record.id}`, { method: 'POST', body: JSON.stringify(payload) });
  return api('/api/api-service/keys', { method: 'POST', body: JSON.stringify(payload) });
}

async function createApiKeyAndShowSecret() {
  const result = await editApiKey();
  if (!result) return false;
  state.apiService = result.state;
  renderApiService();
  await openApiSecretDialog(result.secret);
  return true;
}

elements.apiKeyAdd?.addEventListener('click', async () => {
  try {
    await createApiKeyAndShowSecret();
  } catch (error) { showToast(error.message, true); }
});

elements.apiKeyList?.addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-api-key-edit]');
  const toggle = event.target.closest('[data-api-key-toggle]');
  const remove = event.target.closest('[data-api-key-delete]');
  try {
    if (edit) {
      const record = state.apiService.keys.find((item) => item.id === edit.dataset.apiKeyEdit);
      const result = await editApiKey(record);
      if (!result) return;
      state.apiService = result.state;
      renderApiService();
    } else if (toggle) {
      const record = state.apiService.keys.find((item) => item.id === toggle.dataset.apiKeyToggle);
      const result = await api(`/api/api-service/keys/${record.id}`, { method: 'POST', body: JSON.stringify({ enabled: !record.enabled }) });
      state.apiService = result.state;
      renderApiService();
    } else if (remove && await openApiConfirmDialog('删除后，正在使用该 Key 的客户端会立即失效。', '删除 API Key？')) {
      state.apiService = await api(`/api/api-service/keys/${remove.dataset.apiKeyDelete}`, { method: 'DELETE', body: '{}' });
      renderApiService();
    }
  } catch (error) { showToast(error.message, true); }
});

elements.codexUpdateAction?.addEventListener('click', installCodexUpdate);
elements.updatePrimaryAction.addEventListener('click', () => performApplicationUpdateAction(elements.updatePrimaryAction));
elements.navoSettingsUpdateAction?.addEventListener('click', () => performApplicationUpdateAction(elements.navoSettingsUpdateAction));

elements.form.addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const formData = new FormData(elements.form);
  const requestedLoginMethod = String(formData.get('loginMethod') || 'official');
  if (requestedLoginMethod === 'create-api') {
    elements.dialog.close();
    try { await createApiKeyAndShowSecret(); }
    catch (error) { showToast(error.message, true); }
    return;
  }
  if (requestedLoginMethod === 'relay-import') {
    elements.dialog.close();
    openRelayImportDialog();
    return;
  }
  if (requestedLoginMethod === 'import') {
    if (!state.accountImportPackageText) return showAccountDialogError('请先选择 .codexnavo 授权包');
    elements.accountSubmit.disabled = true;
    elements.accountSubmit.textContent = '正在导入…';
    try {
      const result = await api('/api/auth-packages/import', {
        method: 'POST',
        body: JSON.stringify({ operator: operator(), package: state.accountImportPackageText }),
      });
      const status = result.importStatus || {};
      state.accountImportPackageText = '';
      elements.form.reset();
      elements.dialog.close();
      await refresh();
      showToast(status.web === 'imported'
        ? '账号已导入：Codex 授权与网页会话均已验证'
        : status.web === 'failed'
          ? 'Codex 授权已导入，网页会话需要重新登录'
          : '账号已导入：授权包仅包含 Codex 授权', status.web === 'failed');
    } catch (error) {
      showAccountDialogError(error.message);
    } finally {
      elements.accountSubmit.disabled = false;
      syncAccountLoginMethod();
    }
    return;
  }
  const loginMethod = 'official';
  const route = String(formData.get('route') || 'direct');
  const [sourceId, encodedNode = ''] = route.split('|');
  const emailHint = String(formData.get('emailHint') || '').trim();
  elements.accountDialogStatus.hidden = true;
  elements.accountDialogStatus.textContent = '';
  try {
    const currentOperator = operator();
    const created = await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        operator: currentOperator,
        label: formData.get('label'),
        emailHint,
        loginMethod,
        network: route === 'direct' ? { mode: 'direct' } : { mode: 'proxy', sourceId, nodeName: decodeURIComponent(encodedNode) },
      }),
    });
    elements.form.reset();
    elements.dialog.close();
    showToast('账号已创建，请在独立浏览器中完成登录与授权');
    await refresh();
  } catch (error) {
    showAccountDialogError(error.message);
  }
});

elements.form.addEventListener('change', (event) => {
  if (event.target.name !== 'loginMethod') return;
  syncAccountLoginMethod();
});

syncSortMenu();
initializeApplicationUpdater();
initializeFloatingWindow();
elements.codexLaunchStatusClose?.addEventListener('click', () => {
  state.launchProgressDismissed = true;
  clearTimeout(renderCodexLaunchProgress.hideTimer);
  elements.codexLaunchStatus.hidden = true;
});
pollCodexLaunchProgress();
loadNotificationSettings();
refreshSessions();
refresh();
state.timer = setInterval(() => {
  if (!editingSurfaceActive() && document.visibilityState === 'visible') refresh({ background: true });
}, 5_000);
state.sessionTimer = setInterval(() => refreshSessions(), 2_000);
state.notificationTimer = setInterval(() => pollNotificationEvents(), 1_000);
state.launchProgressTimer = setInterval(() => pollCodexLaunchProgress(), 450);
