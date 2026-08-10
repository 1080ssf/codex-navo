# Codex Navo

面向 Windows 的本地 Codex 账号环境切换器。每个账号使用独立的 Chrome 浏览器配置与 Codex 认证目录；切换账号时继续使用同一套本地项目和任务数据。

> [!IMPORTANT]
> Codex Navo 不是 OpenAI 官方产品，与 OpenAI 无隶属或背书关系。请只管理你有权使用的账号，并遵守适用的服务条款、订阅规则和组织政策。

## 界面预览

![Codex Navo 账号池](docs/images/codex-navo-account-pool.png)

![Codex Navo 本机用量](docs/images/codex-navo-usage-dashboard.png)

## 下载与安装

普通用户建议从仓库右侧的 **Releases** 下载最新安装版：

[下载最新版本](https://github.com/1080ssf/codex-navo/releases/latest)

1. 下载 `Codex-Navo-Setup-<版本>-windows-x64.exe`。
2. 按安装向导完成安装。
3. 后续版本会由应用自动检查；下载完成后由用户确认重启安装。
4. 如果 Windows SmartScreen 提示“未知发布者”，请确认安装包来自本仓库的官方 Release 页面；公开分发版本目前没有商业代码签名。

安装版已经包含 Electron 和本地服务运行时，不需要安装 Node.js。需要预先安装：

- Windows 11 x64
- Google Chrome
- Codex 桌面应用
- Codex CLI（用于官方浏览器登录授权、额度读取和账号唤醒）

## 第一次使用

1. 点击“添加账号”，填写本机可识别的账号名称。
2. 应用会在该账号的独立 Chrome 环境中直接打开 OpenAI 官方登录授权页。
3. 在同一个浏览器流程中完成 ChatGPT 登录和 Codex 授权，成功后账号会自动进入账号池。
4. 以后可以直接打开该账号网页端，或切换并启动 Codex 桌面端。

正常的浏览器登录授权不需要开启“为 Codex 启用设备代码授权”。只有浏览器回调失败并选择“改用设备代码”备用流程时，才需要在 ChatGPT **设置 → 账户安全与登录** 中开启该选项。

关闭主窗口不会退出程序，而是隐藏到 Windows 系统托盘。点击托盘图标可重新显示；右键托盘并选择“退出应用”才会彻底关闭本地服务。

## 主要功能

### 登录方式

- **登录并授权（默认）**：添加账号时直接显示的推荐入口，在账号独立 Chrome 环境中完成官方登录与 Codex OAuth。
- **后台交互登录**：收纳在“更多登录方式”中，参考 toSub2 的交互式协议登录流程，在后台完成 ChatGPT 网页登录并继续官方 Codex OAuth；只有取得官方可刷新的 Codex 凭证后才会入池。
- **导入授权包**：可直接在“添加账号”弹窗中选择 `.codexnavo` 文件，新建账号并恢复其中的 Codex 授权与可用网页会话。
- 后台交互登录失败时，账号卡片可直接切换到官方浏览器登录继续授权。
- 协议登录不连接邮箱验证码提取接口。邮箱验证码与手机号短信验证码一样，由用户收到后在账号卡片中填写并确认。
- 协议登录会继承当前代理环境；从 Windows 桌面启动且未设置代理环境变量时，会读取当前用户启用的系统代理，避免隐藏登录进程与浏览器网络路径不一致。
- 协议 OAuth 请求与官方 Codex CLI 保持一致，包含 `openid profile email offline_access api.connectors.read api.connectors.invoke` scopes；旧版协议登录生成的授权需要重新执行一次协议授权才能取得新增 scopes。
- 协议登录启动后，邮箱验证码、密码、2FA 等交互步骤会一直留在“登录并授权”弹窗中。弹窗关闭后，账号卡片仍保留相同的恢复入口。
- ChatGPT 网页会话不会被当作 Codex OAuth 凭证。旧版生成的临时凭证会标记为“需要官方授权”，重新完成官方 OAuth 后才会启用 Codex 桌面端。
- 网页登录完成后，应用通过仅监听 `127.0.0.1` 的临时 Chrome 调试通道写入网页会话并验证 `/api/auth/session`，验证成功后将独立 Chrome 环境加入账号池。
- 协议登录使用无界面的 Headless Chrome 在后台准备独立账号环境，不再弹出 Chrome 窗口；登录成功、失败或取消时会结束临时浏览器进程。之后点击账号的“网页端”仍会正常打开该账号的可见 Chrome 窗口。
- Headless Chrome 会重试网页会话校验；若仅 Headless 环境被站点返回 HTTP 403，但 Cookie 已成功写入，则保留账号环境并延后到用户打开可见 Chrome 时完成网页验证。
- 网页登录成功后，协议流程会继续 Codex OAuth；若服务端要求手机号、短信验证码或 2FA，应用会显示对应输入框，验证完成并取得官方 refresh token 后再入池。
- 协议接口可能随服务端变化而失效；失败后可以重新发起协议登录，或继续使用原有官方浏览器登录。

协议登录组件包含来自 [poxiao33/toSub2](https://github.com/poxiao33/toSub2) 的 MIT 许可代码，详见 `THIRD_PARTY_NOTICES.md`。

- 为每个账号维护独立浏览器配置目录
- 只使用 OpenAI 官方浏览器 OAuth 流程；设备代码仅作为备用方式
- 持久记录未完成的授权任务，应用重启后可继续或取消
- 检查账号授权健康状态，并识别缺失、损坏或失效的凭证
- 使用单个 `.codexnavo` 文件迁移 Codex 授权与可用的 ChatGPT 网页会话
- 切换 Codex 桌面端账号，同时保留本机项目与任务
- 显示套餐、Codex 点数和周额度
- 当前账号每分钟、其他账号每五分钟自动刷新额度
- 手动刷新单个账号或全部账号额度
- 手动唤醒单个或全部账号，并可按每日时间或额度重置自动唤醒
- 为唤醒请求选择模型、推理强度和发送内容
- 按当前账号、剩余额度、名称或添加时间排序
- 在列表与卡片视图之间切换，并记住上次选择
- 统计本机 Codex 模型调用、输入、缓存、输出、缓存命中率和 Token 估值
- 按今日、昨日、近 7 天、近 30 天或全部范围查看总量与单账号用量
- 列表视图支持独立折叠每个账号的用量详情，并记住折叠状态
- 再次打开账号网页端时恢复该账号上次关闭的 Chrome 窗口
- 管理服务只监听 `127.0.0.1`
- 关闭窗口后驻留 Windows 系统托盘
- 从 GitHub Releases 检查、下载并安装应用更新

## 账号唤醒

“唤醒账号”会使用该账号已经完成的 Codex 授权发送一次真实请求，适合在额度重置后建立新的使用周期。该操作会消耗少量额度，不是模拟按钮。

- 支持手动唤醒单个账号或全部账号。
- 自动唤醒默认关闭，可选择每天执行一次，或在额度重置后执行一次。
- 额度重置检测同时参考预计重置时间、重置时间变化和剩余额度恢复。
- 可以选择 Codex 模型、推理强度和发送内容。
- 自动任务失败后会保留状态并稍后重试，不会在短时间内持续重复请求。

启用自动唤醒前，请确认该使用方式符合你的账号订阅规则和组织政策。

## 授权健康与账号迁移

点击账号池顶部的盾牌按钮可以打开“授权健康与迁移”：

- “账号健康”会检查本地授权文件，并通过 Codex 官方链路验证仍可使用；单账号检查会显示进行中状态和对应结果，完成提示可手动关闭并会自动消失。
- “导出授权”会生成单个 `.codexnavo` 文件，无需密码或配套密钥文件。
- 授权包内部包含版本清单、账号显示信息、去重指纹、完整的官方 Codex `auth.json`，以及可选的 ChatGPT/OpenAI 网页会话 Cookie；不会收集其他网站 Cookie。
- “导入授权”可在本工具中执行，也可直接在“添加账号”弹窗选择“导入授权包”；应用会检查文件完整性、识别重复账号并在线验证两端状态。
- 网页会话通过 Chrome 调试协议导出和写入，由目标电脑的 Chrome 重新落盘加密；不会复制受 Windows DPAPI/App-Bound Encryption 保护的原始 Cookie 数据库。
- 授权包不包含密码、项目、任务、网页历史、缓存或已打开标签页。旧版只含 Codex `auth.json` 的授权包继续兼容；网页会话失效时会保留已成功导入的 Codex 授权并提示重新登录网页端。

`.codexnavo` 是未加密的高度敏感文件，可能包含可用的 Codex 登录令牌和 ChatGPT 网页会话。任何拿到该文件的人都可能获得对应账号权限，请仅通过可信渠道传输，并在迁移完成后删除不再需要的副本。

## 本机 Token 用量

Codex Navo 会读取 Codex 在本机生成的 `token_count` 事件，按账号启动区间汇总模型调用、输入 Token、缓存输入、输出 Token、缓存命中率和 Token 估值。统计数据只保存在本机，不会上传到项目仓库或第三方服务。

- “模型调用”表示模型实际推理调用次数，不等同于用户发送的消息数量。
- “Token 估值”按对应模型的 OpenAI API Token 公开价格计算，不是 Plus/Pro 订阅的实际扣款。
- Token 估值不包含 Web Search、图像生成、Computer Use 等可能单独计费的工具调用。
- 一亿以上的 Token 仍以 `M` 为主值，并额外显示中文“亿”单位提示；悬停可查看完整数字。
- 会话从 `sessions` 移动到 `archived_sessions` 时会沿用原统计游标，避免重复累计。

## 数据与隐私

安装版会把运行数据保存在 `%LOCALAPPDATA%\Codex Switchboard`，升级和卸载程序默认不会删除这些数据。该目录名为早期版本遗留名称，为保证升级后仍能读取原有账号环境而继续保留：

| 路径 | 内容 | 是否敏感 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Codex Switchboard\config\accounts.json` | 账号显示名称、邮箱提示和额度缓存 | 是 |
| `%LOCALAPPDATA%\Codex Switchboard\config\settings.json` | 本机设置和可选的绝对路径 | 可能 |
| `%LOCALAPPDATA%\Codex Switchboard\profiles\browser\` | 独立浏览器配置，可能包含有效 Cookie | 高度敏感 |
| `%LOCALAPPDATA%\Codex Switchboard\profiles\codex\` | 每个账号的 Codex `auth.json` | 高度敏感 |
| `%LOCALAPPDATA%\Codex Switchboard\data\` | 本地访问令牌、租约、日志和状态 | 高度敏感 |

上述路径均已加入 `.gitignore`。不要将它们上传到 Git、网盘、Issue、聊天工具或公开截图中。只有用户主动执行“导出授权”时，工具才会生成包含 Codex 令牌及可选 ChatGPT/OpenAI 会话 Cookie 的 `.codexnavo` 文件；工具不会导出密码、其他网站 Cookie、项目或网页历史。

> [!WARNING]
> Codex 桌面端是单实例应用。切换或退出账号前，请先让正在运行的任务安全结束，否则任务可能被中断。

## 从源码运行

开发环境需要 Node.js 20 或更高版本：

```powershell
git clone https://github.com/1080ssf/codex-navo.git
cd codex-navo
npm install
Copy-Item config/settings.example.json config/settings.json
npm run dev
```

也可以双击 `启动桌面开发版.bat`。

`config/settings.json` 示例：

```json
{
  "port": 47821,
  "operators": [],
  "browserExecutable": "",
  "codexDesktopExecutable": "",
  "codexCliExecutable": "",
  "browserStartUrl": "https://chatgpt.com/",
  "mockLaunch": false
}
```

路径留空时会自动探测。`mockLaunch` 仅用于测试，不会真的打开浏览器或 Codex。

## 测试与构建

```powershell
npm test
npm run test:smoke
npm audit --audit-level=high
npm run build:desktop
```

安装版输出到 `release/auto-update/`。发布自动更新版本时，必须把 Setup 安装程序、`.blockmap` 和 `latest.yml` 一起上传到同一个非草稿 GitHub Release。开发模式不会连接更新服务。

## 已知限制

- 当前只针对 Windows 11 x64 测试。
- 未签名的 EXE 可能触发 SmartScreen。
- 浏览器或 Codex 会话失效后，需要重新完成官方认证。
- 授权包可迁移 Codex 授权与导出时仍有效的 ChatGPT 网页会话，但服务端仍可能根据会话有效期或安全策略要求重新验证。
- Windows Chrome Cookie 数据库受 DPAPI/App-Bound Encryption 保护，因此应用不复制数据库，而是通过 Chrome 调试协议迁移限定域名的标准 Cookie；目标端仍以在线校验结果为准。
- 不支持同时运行多个 Codex 桌面端实例。

## 参与和安全报告

- 发现普通问题：提交 GitHub Issue，但不要附带账号、日志、认证文件或未打码截图。
- 发现安全问题：优先使用 GitHub Private Vulnerability Reporting，详见 [SECURITY.md](SECURITY.md)。
- 第一次发布本项目：按照 [GitHub 首次发布指南](docs/PUBLISHING.md) 操作。

## 许可证

[MIT License](LICENSE)
