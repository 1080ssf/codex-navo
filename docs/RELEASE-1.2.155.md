# Codex Navo 1.2.155

- 修复 Windows elevated Agent sandbox 导致消息发送被要求更新沙盒的问题。
- 启动时只修改临时隔离配置，原始用户配置在退出后恢复。
- 配额展示规划参考 jlcodes99/cockpit-tools：按窗口时长、百分比、重置时间、套餐和账号类型分别建模。

验证边界：未使用真实账号发送消息；需在出现问题的电脑上安装后验证普通账号和 API Codex。
