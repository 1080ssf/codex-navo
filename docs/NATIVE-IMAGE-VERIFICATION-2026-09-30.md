# API Codex 内置生图修复与验证

## 根因

1. 1.2.159 的图片 HTTP 接口可用，不代表 Codex 会话注册了内置工具。Navo 自定义 provider 使用 `requires_openai_auth = false`，没有 actor 授权头；Codex 的 image extension 因此不提供 `image_gen`。
2. 原生工具使用独立的 `/images/generations` 和 `/images/edits` JSON 请求。之前只有生成接口，编辑接口缺失。
3. Codex 0.159.0 工具写死 `gpt-image-2`，而账号接口默认生图模型采用 `gpt-image-2.5`。只修改 HTTP 测试传入的模型，不能改变实际客户端行为。

## 来源（2026-09-30 核对）

- [Codex 对应版本的工具启用条件](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/ext/image-generation/src/extension.rs)：OpenAI provider、需要 OpenAI 登录、静态 actor 授权三者之一。
- [对应版本的 provider 授权判断](https://github.com/openai/codex/blob/rust-v0.159.0/codex-rs/model-provider-info/src/lib.rs)：`uses_openai_actor_authorization`。
- [Cockpit 本地接管配置校验](https://github.com/jlcodes99/cockpit-tools/blob/4ea6a34df6aa3b2d494c3cca5983bd09a84a9e3a/src-tauri/src/modules/codex_local_access_profile_takeover.rs)：纯 API Key 路径也要求 `requires_openai_auth = false` 加 actor 授权。
- [Cockpit 图片接口转换](https://github.com/jlcodes99/cockpit-tools/blob/4ea6a34df6aa3b2d494c3cca5983bd09a84a9e3a/sidecars/cockpit-cliproxy/image_relay.go)：独立图片接口转换成文本模型驱动的 hosted image tool。
- [OpenAI 官方内置生图说明](https://learn.chatgpt.com/docs/image-generation)与[公开 API 图片工具说明](https://developers.openai.com/api/docs/guides/tools-image-generation)。两个产品入口不应混为一谈。

## 验证方式和边界

使用实际安装的 Codex 0.159.0 `app-server`，独立临时 CODEX_HOME 和工作目录，加载 Navo 生产代码生成的 provider 配置和生产网关 handler。没有修改当前会话、账号、系统代理，没有重启桌面应用。

- 旧配置复现：请求里的可用工具定义不含 `image_gen`，图片请求 0 次。
- 修复后模拟生成：原生工具可见，调用图片接口，返回 `imageGeneration: completed` 并保存图片。
- 修复后模拟编辑：原生工具将本地参考图送到 JSON edits 接口；上游工具 action 为 `edit`，参考图片 1 张，返回完成并保存。
- 真实生成：原生 Codex 自己选择并执行工具，2 次文本请求、1 次图片请求，图片工具模型为 `gpt-image-2.5`，约 57.9 秒；`imageGeneration` 状态 completed，保存 648,201 字节 PNG（1254×1254），已目视确认白底蓝圆。
- 真实请求通过当前已登录的本机 Navo 账号池转发；没有使用 OpenAI Platform 付费 Key。账号权限和上游容量仍由上游决定。
- 图片编辑本轮只做原生核心 + 模拟上游验证，没有额外消耗额度进行真实编辑。

运行脚本：`scripts/probe-codex-native-image.cjs --mock|--live --cli <Codex核心路径>`。`--mock --baseline` 重现旧配置，`--mock --edit` 检查编辑链路。真实测试须显式传 `--live`，最多允许 1 次图片请求；日志不包含凭证或图片 base64。

本机验证日志：`verification/native-image-baseline-2026-09-30.log`、`verification/native-image-edit-2026-09-30.log`、`verification/native-image-live-2026-09-30.log`。真实图片：`verification/image-generation/native-codex.png`。这些验证产物不打入安装包。
