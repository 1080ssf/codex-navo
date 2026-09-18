# Codex Navo 1.2.152

## 中文

- Navo 的 GitHub 更新检查、安装包下载与重试固定走 Navo 配置的代理，不再测速选线或自动回退直连。
- Codex 官方 CDN 更新检查、安装包下载与重试固定使用显式直连，不再准备或依赖账号代理。
- Navo 没有可用代理时提示配置代理；保留分段下载、缓存续传、有限重试和原有安装校验。
- 包含 1.2.151 的深色模式和启动前项目选择弹窗滚轮修复。

## English

- Keep Navo GitHub update checks, downloads and retries on the configured proxy, without automatic direct fallback or route sampling.
- Use explicit direct connections for Codex official CDN checks, downloads and retries, without preparing an account proxy.
- Show a clear message when Navo has no configured proxy. Preserve segmented downloads, resumable cache, bounded retries and installer validation.
- Includes the appearance and project-picker scrolling fixes from 1.2.151.

## 范围

上述设置作用于 Navo 管理的下载会话，不改变账号、Codex 任务及系统代理。微软商店辅助服务如被使用，仍由 Windows 自己联网，本次未改其系统网络策略。未执行覆盖安装或关闭正在运行的 Codex。
