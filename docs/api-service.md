# Codex Navo API 服务

## 能做什么

- 把已完成官方 Codex OAuth 的账号池转换为 OpenAI 兼容 API。
- 生成独立的 `sk-navo-...` Key，并限制模型、请求数、Token 数和到期时间。
- 提供 `GET /v1/models`、`POST /v1/responses`、`POST /v1/chat/completions`、`POST /v1/images/generations` 和 JSON 格式的 `POST /v1/images/edits`。
- 根据剩余额度和最近使用时间选择账号；遇到临时限流或服务错误时尝试下一个可用账号。

外部模型供应商接入已经移除。API 服务只使用 Codex Navo 账号池，不会读取旧供应商地址或密钥。

## 本机调用示例

在“API 服务”页面创建 Key。完整 Key 只显示一次，请及时复制保存。

```powershell
$headers = @{ Authorization = "Bearer sk-navo-REPLACE_ME"; "Content-Type" = "application/json" }
$body = @{ model = "gpt-6.1-sol"; input = "hello" } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:18300/v1/responses -Method Post -Headers $headers -Body $body
```

Chat Completions 客户端把 Base URL 设置为固定地址 `http://127.0.0.1:18300/v1`，API Key 设置为创建的 Navo Key。若 18300 被其他程序占用，Navo 会明确记录端口冲突，不会静默改用其他端口。账号与 API 线路代理从 `18301-18399` 动态选择空闲端口，运行结束后可供其他线路复用。

## 图片生成

`/v1/images/generations` 支持 `gpt-image-2.5`，并保留 `gpt-image-1`、`gpt-image-1-mini`、`gpt-image-1.5` 等兼容入口。Navo 在账号池内选择可用的 Codex 文本模型驱动 `image_generation` 工具；文本模型和图片工具模型是两个不同的字段，不会把 `gpt-image-*` 当作顶层聊天模型发送。优先使用账号池默认文本模型，默认图片工具仍为 `gpt-image-2.5`。当前图片接口每次请求支持 `n=1`，以 JSON 返回 `data[0].b64_json`。

```powershell
$headers = @{ Authorization = "Bearer sk-navo-REPLACE_ME"; "Content-Type" = "application/json" }
$body = @{ model = "gpt-image-2.5"; prompt = "一只戴着宇航员头盔的橘猫，柔和插画风"; size = "1024x1024" } | ConvertTo-Json
Invoke-RestMethod http://127.0.0.1:18300/v1/images/generations -Method Post -Headers $headers -Body $body
```

图片入口模型是虚拟兼容名，显式限制模型的 Key 需要把对应的 `gpt-image-*` 加入允许列表；空允许列表的旧 Key 默认可用。若上游账号或模型不支持图片工具，接口会返回具体的上游错误或观测到的事件类型。

Codex 原生的 Responses 生图请求保留用户选择的聊天模型及 `image_generation` 工具配置，不要求切换为某个指定文字模型。开始输出后不重发生成；图片进度会及时转发，最终 `response.completed.output` 会补齐之前工具事件中的图片结果。

### Codex 桌面内置工具

从 Navo 启动 API Codex 时，临时 provider 配置携带指向本机网关的 `x-openai-actor-authorization`，让当前 Codex 核心注册 `image_gen.imagegen`。该值使用本次启动的 Navo Key，不伪造 ChatGPT 登录，不配置另外收费的 OpenAI Platform Key，也不把本机 Key 转发到账号上游。退出后与启动配置一起还原。

Codex 0.159.0 的原生工具目前发送 `gpt-image-2`。携带匹配本机授权头和原生 turn 标识的受管理请求，使用 Navo 默认的账号图片工具 `gpt-image-2.5`；外部调用者显式请求 `gpt-image-2` 时仍原样保留。模型允许列表和账号池权限继续生效。

`/v1/images/edits` 接受 Codex 使用的 JSON：`prompt`、`model` 和包含 1–5 个 `{ "image_url": "data:image/png;base64,..." }` 或 `{ "file_id": "..." }` 的 `images` 数组。不接受 multipart 上传。实际背景、尺寸、质量以可取得的上游元信息为准，不用请求值假冒结果。更新 Navo 后，需要退出当前 API Codex 并从 Navo 重新启动，才会加载新的工具配置；已有会话可以继续使用。

OpenAI [公开 API 文档](https://developers.openai.com/api/docs/guides/image-generation)中的 `gpt-image-2.5-sunburst` 与 `gpt-image-2.5-flare` 是公开型号名称，不能仅据此推断 Codex 账号接口的名称或权限。2026-09-30 的本机实测确认 `gpt-6-astra` + `gpt-image-2.5` 成功返回 PNG；修复后的 `/v1/images/generations` 也通过真实生成。该结果仅证明测试账号当时可用，不代表所有套餐均支持。尺寸和质量参数由上游执行，Navo 不伪造实际输出尺寸。

## 账号池要求

账号必须已经在 Codex Navo 中完成官方 Codex OAuth。请求仍受账号套餐额度和 OpenAI 服务规则约束。账号池 OAuth 只从各账号本机授权目录读取，不写入下游响应或日志。

## 局域网访问

网关默认只监听 `127.0.0.1`。如需在公司局域网内使用，可在配置中启用局域网访问，重启 Codex Navo 后生效。远程客户端使用主机实际 IP 和独立 Navo Key。

公网部署时应由 Caddy、Nginx 或 Cloudflare Tunnel 提供 TLS 和访问控制，不直接暴露 8317。建议为每个成员创建独立 Key，并设置模型权限、额度和到期时间。

## Key 存储

- Navo API Key 只保存 scrypt 加盐哈希，完整 Key 创建后不再回显。
- 旧版外部供应商配置不会被加载或暴露。
- 旧 Key 会在启动时自动迁移到账号池，旧外部模型权限会被清理。
