# Codex Navo 1.2.153

- 修复授权包遗漏分片网页登录 Cookie 的问题，保留原始域作用范围。
- 网页验证失败后保留已导入的数据，尝试正常关闭浏览器以保存 Cookie；可打开网页端继续验证。已失效的会话仍需重新登录，旧包若未包含网页会话则需要重新导出。
- 大量会话名称通过 UTF-8 标准输入同步，避免 Windows 命令行参数过长；同步失败不再中断启动。

## English

- Include chunked web-session cookies and preserve their domain scope.
- Retain imported browser data after verification failures and gracefully close Chrome to flush cookies. Open the web page to verify sign-in; expired sessions still require signing in again.
- Transfer conversation names through UTF-8 stdin instead of command-line arguments. Optional name-sync failures no longer block startup.

## Verification boundary

Regression tests use synthetic cookies and isolated temporary conversation databases. No real user authorization package was imported and no remote user's machine was accessed.
