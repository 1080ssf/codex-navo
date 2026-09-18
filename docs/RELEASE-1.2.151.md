# Codex Navo 1.2.151

## 中文

- 修复启动前项目选择弹窗只能拖动滚动条、鼠标滚轮无效的问题。
- 应用设置支持浅色、深色、跟随系统，立即生效并记住选择；补齐主页面、账号卡片、输入框、下拉菜单、模型检测、重置卡、创建 Key、网络和更新界面的主题颜色。
- Navo 与 Codex 更新按各自安装包来源，短测直连和当前配置代理，选择本次下载线路。代理准备失败可尝试直连公共更新源；不会改变账号、任务或 Windows 全局代理。
- Codex 大包最多四路分段下载，校验 ETag、范围和分段缓存哈希；中断后复用完整分段，不支持可靠分段时回退原单流续传。网络错误有限重试，取消操作停止继续尝试。
- Navo 保留原有差分下载和安装包校验，增加网络中断及临时服务错误的有限重试。显示所用下载线路及重试次数。

## English

- Fix mouse-wheel scrolling in the project selection dialog before launch.
- Restore persistent light, dark and system appearance, including account cards, forms, pickers, diagnostics, credits, API key dialogs, network and update pages.
- Sample direct and configured proxy routes separately for each public update source. Account, task and Windows proxy settings remain unchanged.
- Download large Codex packages with up to four validated ranges, retain verified completed chunks and retry transient failures. Fall back to single-stream downloading when reliable range requests are unavailable.
- Preserve Navo differential downloads and package verification while adding bounded transient retries and route/retry display.

## 验证与边界 / Verification and limits

- 隔离假账号页面覆盖八个主页面、主要弹窗、卡片布局和中英文设置；实际鼠标滚轮使选择弹窗滚动 400 像素。验证主题持久化、系统主题实时跟随、显式浅色不随系统变动。截图与粗略对比度扫描不是正式无障碍认证。
- 完整回归当次 676 项中 675 项通过；一项旧事务测试在结束清理临时目录时发生 ENOTEMPTY，随后独立复跑通过。新增及相关更新测试最终 36/36 通过；编码和语言审计通过。
- 本机官方源短测：各下载前 1 MiB，Codex 直连约 599 KiB/s、当前代理约 224 KiB/s；Navo GitHub 源直连约 62 KiB/s、代理约 164 KiB/s。另用 Electron 43.2.0 对 Codex 官方源进行四路限量分段读取，共 1 MiB，成功完成。
- 短测不代表持续吞吐量，不承诺倍数提速。未关闭正在运行的 Codex，未执行整包覆盖安装，未验证用户此前每一次更新失败的原因。保留安装后版本核对，下载完成不等于更新安装成功。
- 没有调用模型、唤醒账号或兑换重置卡；没有上传 GitHub。
