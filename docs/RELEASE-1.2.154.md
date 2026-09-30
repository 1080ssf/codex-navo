# Codex Navo 1.2.154

- 普通账号/API Codex 使用可恢复的 CODEX_HOME/.env 临时代理配置，让原生后台不再仅依赖启动器环境继承。仅写代理变量，退出与失败时恢复，不修改系统代理。
- 修正账号选择行对齐、限流冷却计算和流式 UTF-8 分块解码。
- 修正 HY2 单链接 userpass、混淆密码重复解码与证书指纹遗漏；这些修复不等于已复现另一台电脑的全部网络故障。
- 注册版 Codex 优先通过 Windows 系统激活，保留代理参数和临时登录配置；不修改官方安装文件。
- 更新前分别测试直连和已配置代理，下载时测试实际安装包的小段数据。测速使用独立会话，不修改系统和账号代理。
- 新增 GPT-6 Sol、Luna 标准价格及长上下文估值；API 模型检测结果同步账号池。
- 价格来源：https://developers.openai.com/api/docs/models/gpt-6-sol 和 https://developers.openai.com/api/docs/models/gpt-6-luna。

## English

- Before downloading, measure direct and configured-proxy routes and use the faster available route.
- Codex official updates and Navo GitHub updates share the same route selection and retry behavior.
- Model detection continues to use each account's actual returned model catalog. Unknown pricing remains unpriced instead of guessed.
- Add official standard GPT-6 Sol/Luna prices and synchronize detected models with the API pool.
- Launch registered MSIX installations through Windows activation to retain package identity.

## Validation boundary

Regression tests use isolated fixtures. No live account request, Codex restart, or real update installation is performed as part of those tests. Model catalog visibility is not proof of live account access.

Official CLI 0.154.0 was also run with an isolated home, no account credentials and no inherited proxy variables. Native HTTPS CONNECT requests reached a loopback test proxy through the staged .env settings. The test proxy forwarded nothing to the Internet. Windows desktop behavior on the affected remote computer still requires user verification.
