# 本机邮件验证码 Mock 测试

此工具用于验证 Codex Navo 的验证码解析、基线、去重和置信度状态机，不连接真实邮箱或真实登录流程。

如果只需要检查一个本地响应样本，不启动服务，可以运行：

```powershell
npm run test:mail-otp
```

命令只输出候选数量和置信度统计，不输出完整验证码。

如果样本是专门构造的本地测试数据，可以显式显示解析到的测试码：

```powershell
node scripts/mail-otp-check.js --fixture "C:\temp\mail.json" --show-code
```

`--show-code` 不能与网络端点或持续轮询模式一起使用。

## 持续轮询测试

先启动本机 Mock 服务，然后打开另一个终端执行：

```powershell
$env:MAIL_POLL_INTERVAL_MS = '2500'
$env:MAIL_POLL_TIMEOUT_MS = '600000'
node scripts/mail-otp-check.js --endpoint "http://127.0.0.1:48080/query" --watch
```

脚本会先建立基线。随后修改样本中的消息 ID、时间和验证码，即可验证新候选检测。测试完成后可删除两个环境变量。

也可以直接启动交互模式：

```powershell
node scripts/mail-otp-check.js
```

脚本会提示输入本机 Mock 邮件接口地址，然后自动建立基线并持续轮询。

## 1. 准备本地样本

创建一个 JSON、HTML 或纯文本文件，例如 `C:\temp\mail.json`：

```json
{
  "messageId": "mock-message-001",
  "receivedAt": "2026-08-09T12:00:00Z",
  "body": "Your verification code is 123456."
}
```

## 2. 启动 Mock 服务

在项目目录运行：

```powershell
node scripts/mail-otp-mock-server.js --fixture "C:\temp\mail.json" --port 48080
```

工具会显示本机接口地址，例如：

```text
http://127.0.0.1:48080/query
```

## 3. 在应用中测试

1. 打开“添加账号”。
2. 展开“邮件收码测试（本机适配器）”。
3. 填入 Mock 工具显示的地址。
4. 点击“建立基线”。
5. 修改样本文件的 `messageId`、时间和六位验证码，保存文件。
6. 点击“检测新验证码”。

应用只显示检测状态，不显示或保存完整验证码。低置信候选需要连续检测两次才会确认。
