# 公网邮件元数据采集器

该独立终端脚本用于检查公网邮件接口的连通性和非敏感结构，不采集邮件正文、主题、验证码、令牌、Cookie、鉴权参数或密码重置链接。

```powershell
cd "C:\Users\A醋\Desktop\Codex账号切换\Codex Switchboard"
node scripts/mail-metadata-collector.js
```

根据提示粘贴公网 HTTP(S) 接口地址。也可以直接传参：

```powershell
node scripts/mail-metadata-collector.js --endpoint "https://example.com/mail-api"
```

输出包括：

- 脱敏后的接口地址
- HTTP 状态与 Content-Type
- 响应大小和 JSON/HTML/文本格式
- JSON 对象数、数组项目数和非敏感字段名
- 消息 ID 的不可逆短指纹
- 消息时间和读取状态

脚本拒绝私网、回环和链路本地地址，不跟随跨源重定向，响应上限为 2 MB，单次请求超时为 12 秒。
