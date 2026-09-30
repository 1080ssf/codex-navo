# Codex Navo 1.2.160

日期：2026-09-30。以下汇总自上次公开源码版本 1.2.153 以来的主要变更。

## API Codex 内置生图

- 修复图片 HTTP 接口可用、但 Codex 会话没有注册内置 `image_gen.imagegen` 工具的问题。
- 补齐原生工具使用的图片生成及 JSON 图片编辑接口。受 Navo 管理的原生请求使用 `gpt-image-2.5`，保留参考图片与上游实际返回的图片信息。
- 图片进度及时转发，最终 Responses 输出补齐图片工具结果；已经开始输出的生成不自动重放。
- 继续使用本机 Navo Key 与账号池，不需要额外配置 OpenAI Platform Key。账号是否有权限、上游是否有容量，仍以实际响应为准。
- **更新后请退出 API Codex，再从 Navo 启动一次**，以加载新工具配置；已有会话可以继续使用。

## 账号、模型与授权迁移

- 更新 GPT-6 系列及 GPT-6.1 Sol 的模型目录、检测与已知价格匹配；未知价格保留未定价状态，不猜算。估值不是 ChatGPT 订阅的实际扣费。
- 修复模型目录刷新影响 Key 允许列表的问题，保留已有默认模型与权限设置。
- 授权导出支持多个账号及 Navo、Sub2、CPA 格式；导入统一进入“添加账号 → 导入数据包”，支持 CPA ZIP 和导入时统一选择网络线路。
- 授权导出增加搜索、筛选全选和重复提交保护，修正账号选择行及导出区域布局。
- 集成 ModelTrace 本地归因分析及公开参考数据。测试会发起模型请求并消耗额度；百分比只表示参考集合内的统计相似度，不是模型身份或路由证明。
- 完善账号池临时失败冷却、切换与错误反馈。会话界面自动点击重试暂不启用。

## 启动、代理与更新

- 注册版 Codex 通过 Windows 系统激活保留程序包身份；为原生后台补充可恢复的临时代理配置。
- 修正 HY2 单链接部分参数处理、流式 UTF-8 分块解码和 Windows 沙盒启动兼容问题。
- Navo 与 Codex 更新前比较直连和已配置代理，下载阶段采样实际安装包，选择可用的较快线路；不修改系统或任务代理。

## 验证与已知边界

- 完整回归测试 **745 项通过，0 失败、0 跳过**；通过编码、界面文案、版本及更新产物校验。
- 发布前对待提交文件的干净检出再次检查，修正两项测试对 Windows 换行符的依赖；其所在测试文件 10 项复验通过，其余 735 项已通过。此修正仅影响测试，不改变安装包运行代码。
- 使用实际 Codex 0.159.0 核心验证原生工具发现、真实生成和图片保存整条链路。图片编辑完成原生核心加模拟上游回归，未额外进行真实编辑请求。
- JSON 图片编辑目前不支持 multipart 上传。不同账号套餐、上游容量与其他电脑的网络环境仍可能影响结果。
- 当前 Windows 安装包未进行代码签名。
- 详细生图验证见 [验证记录](NATIVE-IMAGE-VERIFICATION-2026-09-30.md)，接口用法见 [API 文档](api-service.md)。

## 发布文件

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Codex-Navo-Setup-1.2.160-windows-x64.exe` | 116831781 | `1eed41d88caa55f982f8dbbca57571623f0b90e550f0a58252ee760a413f7e51` |
| `Codex-Navo-Setup-1.2.160-windows-x64.exe.blockmap` | 123713 | `4fbe02a827873db0b7142fb11c0f5f106ef44c8c0c98b2549960b63f648431cd` |
| `latest.yml` | 379 | `4dad36b04a1b3f482235ed2110fb2f9e05956731c7db6b43a0ddd16b22fb9b0d` |

安装包及两个自动更新配套文件已核对一致；`latest.yml` 中的安装包大小和 SHA-512 也与本地构建相符。

## English summary

- Restore API Codex's native image tool registration, generation, and JSON edits without a separate OpenAI Platform key. Restart API Codex from Navo after updating.
- Refresh model catalog/pricing support, preserve key model restrictions, and improve account-pool failure handling.
- Consolidate package imports, support multi-account exports, and bundle the ModelTrace reference bank for local statistical attribution analysis.
- Improve registered Windows app activation, native proxy inheritance, and measured update route selection.
- 745 regression tests passed. Native image generation was verified with a live account; image edits were verified against a mock upstream. The installer remains unsigned.
