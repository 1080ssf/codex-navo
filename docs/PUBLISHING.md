# GitHub 首次发布指南

这份指南面向第一次公开 GitHub 项目的维护者。以下命令都在 `Codex Switchboard` 源码目录中执行。

## 1. 先保护提交邮箱

Git 会把作者名称和邮箱永久写入每一次提交。当前仓库尚未配置提交身份，建议先在 GitHub 开启邮箱隐私：

1. 登录 GitHub。
2. 打开头像 → **Settings** → **Emails**。
3. 勾选 **Keep my email addresses private**。
4. 复制 GitHub 显示的 `...@users.noreply.github.com` 邮箱。
5. 只为当前仓库设置身份，不修改全局配置：

```powershell
cd "C:\path\to\Codex Switchboard"
git config user.name "你的 GitHub 昵称"
git config user.email "你的 GitHub noreply 邮箱"
```

检查时不要把邮箱截图公开：

```powershell
git config --local user.name
git config --local user.email
```

## 2. 在 GitHub 创建空仓库

1. 打开 <https://github.com/new>。
2. Repository name 填写 `codex-navo`。
3. Description 可填写：`A local Windows account environment switcher for Codex.`
4. Visibility 选择 **Public**。
5. 不要勾选 README、`.gitignore` 或 License；本地已经准备好了这些文件。
6. 点击 **Create repository**。

## 3. 提交前做最后检查

确认 Git 实际准备提交哪些文件：

```powershell
git status --short
git add --dry-run .
```

以下内容绝对不能出现：

- `config/accounts.json`
- `config/settings.json`
- `data/`
- `profiles/`
- `auth.json`
- 浏览器 `Cookies` 或 `Local State`
- 真实账号邮箱、Windows 用户名、验证码或截图

运行项目检查：

```powershell
npm test
npm run test:smoke
npm audit --audit-level=high
```

## 4. 创建第一次提交

```powershell
git add .
git diff --cached --check
git diff --cached --stat
git commit -m "Initial open-source release"
git branch -M main
```

`git diff --cached --check` 没有输出通常代表没有空白格式错误。`git diff --cached --stat` 只显示文件统计，适合再次确认范围。

## 5. 连接并推送 GitHub

把 `<your-name>` 替换为你的 GitHub 用户名：

```powershell
git remote add origin https://github.com/<your-name>/codex-navo.git
git remote -v
git push -u origin main
```

GitHub 不接受账户密码进行 Git 推送。Windows 通常会自动打开 Git Credential Manager 登录窗口；按照浏览器提示授权即可。不要把 Personal Access Token 写入命令、脚本或仓库文件。

## 6. 完善仓库首页

在 GitHub 仓库页面点击右侧 **About** 的齿轮：

- Description：`A local Windows account environment switcher for Codex.`
- Topics：`codex`、`electron`、`windows`、`account-switcher`、`local-first`
- 勾选 Releases；是否开启 Issues 和 Discussions 可按需要决定。

在 **Settings → Security** 中建议：

- 开启 **Private vulnerability reporting**。
- 开启 Dependabot alerts。
- 如果以后有多人协作，再配置分支保护或 Rulesets。

## 7. 发布 Windows v1.0.0

不要把 ZIP 或 EXE 提交进 `main` 分支。它们已经被 `.gitignore` 排除，应该作为 Release 附件上传。

1. 打开仓库右侧 **Releases** → **Draft a new release**。
2. 点击 **Choose a tag**，输入 `v1.0.0` 并创建新标签。
3. Release title 填写 `Codex Navo v1.0.0`。
4. 上传 `release/Codex-Switchboard-v1.0.0-windows-x64.zip`。
5. Release notes 可参考根目录的 [CHANGELOG.md](../CHANGELOG.md)。
6. 在说明中附上 ZIP 的 SHA-256。
7. 确认不是预发布版本后点击 **Publish release**。

计算 SHA-256：

```powershell
Get-FileHash .\release\Codex-Switchboard-v1.0.0-windows-x64.zip -Algorithm SHA256
```

## 8. 发布后检查

使用无痕窗口打开公开仓库，逐项确认：

- README 能正常显示。
- 仓库中没有 `data`、`profiles`、`accounts.json` 或 `settings.json`。
- Git 提交作者邮箱显示为 GitHub `noreply`。
- Release ZIP 可以下载并正常解压。
- 在另一处临时目录运行便携版，初始账号池应为空。
- GitHub 搜索仓库中的真实邮箱、Windows 用户名和账号 ID，结果应为空。

## 9. 后续版本发布流程

每次发布前：

```powershell
git status
npm test
npm run test:smoke
npm audit --audit-level=high
npm run build:desktop
```

然后更新版本号和 `CHANGELOG.md`，提交源码，再创建新标签和 Release。自动更新版本必须把 `release/auto-update/` 中以下文件一起上传：

- `Codex-Switchboard-Setup-<版本>-windows-x64.exe`
- 对应的 `.blockmap`
- `latest.yml`

Release 不能保持 Draft，否则客户端无法发现更新。不要复用旧安装包，也不要忘记重新计算 SHA-256。安装包版本、Git 标签和 Release 版本必须一致。

## 10. 如果不小心上传了凭据

仅删除 GitHub 页面上的文件不够，因为内容仍可能存在于 Git 历史和他人的缓存中。应立即：

1. 退出或撤销受影响的 ChatGPT/Codex 会话。
2. 修改相关密码，并按需要撤销设备和令牌。
3. 将仓库临时设为 Private。
4. 使用 `git filter-repo` 清理完整历史，再强制推送。
5. 检查 Fork、Actions 日志、Release 附件和 Issue 附件。
6. 如果信息非常敏感，联系 GitHub Support 请求清除缓存。

凭据轮换永远优先于清理 Git 历史；已经公开过的令牌应视为失效，不能继续使用。
