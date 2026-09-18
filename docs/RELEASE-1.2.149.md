# Codex Navo 1.2.149

## 中文

- API Codex 遇到 Windows 拒绝直接启动（EPERM/EACCES）时，新增系统应用激活回退，与普通账号一致支持备用启动。
- 两类账号均通过系统激活接口传递代理、语言及语言桥接参数；为任务子进程补充临时代理配置，退出时恢复原配置，不修改 Windows 全局代理。
- 普通账号启动显式使用 ChatGPT 登录、内置 OpenAI provider 和文件凭证；过滤继承的 API 环境变量，避免残留 API 配置影响登录类型。
- 普通账号拒绝 API-only 授权，授权回写要求登录类型及账号身份匹配，防止 API Key 或其他账号覆盖原凭证。
- API 启动事务进行中不会被后台状态检测提前恢复配置；可选语言桥接失败不再误报整个启动失败。

## English

- Add Windows application activation fallback for API Codex when direct launch fails with EPERM/EACCES, matching regular-account fallback support.
- Forward proxy, language and language-bridge arguments through system activation. Apply temporary task proxy settings and restore the original configuration on exit, without changing the Windows global proxy.
- Explicitly select ChatGPT login, the built-in OpenAI provider and file credentials for regular accounts. Filter inherited API environment variables to prevent stale API configuration from changing the login type.
- Reject API-only credentials for regular accounts and require matching login type and account identity before credential writeback.
- Keep API launch configuration protected during an active launch transaction. Optional language-bridge failures no longer fail the entire startup.

## 验证边界

使用隔离数据验证身份配置、回写保护、回退流程与配置恢复；Windows 激活辅助代码已做本机编译验证，官方稳定 CLI 0.154.0 接受两种隔离登录配置并完成握手。没有启动、切换或读取真实账号，也没有在报错的另一台电脑现场验证系统激活与登录界面。
