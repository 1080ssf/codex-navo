# Codex Navo API 服务

## 能做什么

- 把已完成官方 Codex OAuth 的账号池转换为 OpenAI 兼容 API。
- 生成独立的 `sk-navo-...` Key，并限制模型、请求数、Token 数和到期时间。
- 提供 `GET /v1/models`、`POST /v1/responses` 和 `POST /v1/chat/completions`。
- 根据剩余额度和最近使用时间选择账号；遇到临时限流或服务错误时尝试下一个可用账号。

外部模型供应商接入已经移除。API 服务只使用 Codex Navo 账号池，不会读取旧供应商地址或密钥。

## 本机调用示例

在“API 服务”页面创建 Key。完整 Key 只显示一次，请及时复制保存。

```powershell
$headers = @{ Authorization = "Bearer sk-navo-REPLACE_ME"; "Content-Type" = "application/json" }
$body = @{ model = "gpt-5.6-codex"; input = "hello" } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:18300/v1/responses -Method Post -Headers $headers -Body $body
```

Chat Completions 客户端把 Base URL 设置为固定地址 `http://127.0.0.1:18300/v1`，API Key 设置为创建的 Navo Key。若 18300 被其他程序占用，Navo 会明确记录端口冲突，不会静默改用其他端口。账号与 API 线路代理从 `18301-18399` 动态选择空闲端口，运行结束后可供其他线路复用。

## 账号池要求

账号必须已经在 Codex Navo 中完成官方 Codex OAuth。请求仍受账号套餐额度和 OpenAI 服务规则约束。账号池 OAuth 只从各账号本机授权目录读取，不写入下游响应或日志。

## 局域网访问

网关默认只监听 `127.0.0.1`。如需在公司局域网内使用，可在配置中启用局域网访问，重启 Codex Navo 后生效。远程客户端使用主机实际 IP 和独立 Navo Key。

公网部署时应由 Caddy、Nginx 或 Cloudflare Tunnel 提供 TLS 和访问控制，不直接暴露 8317。建议为每个成员创建独立 Key，并设置模型权限、额度和到期时间。

## Key 存储

- Navo API Key 只保存 scrypt 加盐哈希，完整 Key 创建后不再回显。
- 旧版外部供应商配置不会被加载或暴露。
- 旧 Key 会在启动时自动迁移到账号池，旧外部模型权限会被清理。
