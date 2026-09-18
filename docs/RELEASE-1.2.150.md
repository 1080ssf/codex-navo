# Codex Navo 1.2.150

## 中文

- 修复工作空间 Business×5 套餐在主界面显示“套餐待识别”、在悬浮窗没有对应套餐标签的问题。
- 订阅查询优先使用账号独立网页的登录态，只读取当前账号对应工作空间的信息；到期日和续费日分别处理，不推算缺失日期。
- 区分需要网页验证、需要网页登录、订阅访问被拒绝、工作空间未匹配等情况，并提供中英文提示。
- 遇到网页验证时停止连续重试，降低后台自动重试频率；同一账号的并发查询合并，失败时保留上次有效日期。
- 包含 1.2.149 的启动回退与普通账号/API 登录隔离修复。

## English

- Recognize the Business×5 workspace tier in account cards and the floating window, without treating other Business tiers as 5× plans.
- Prefer the account's own signed-in web session for subscription reads and match the exact workspace. Keep expiration and renewal dates separate; do not infer missing dates.
- Distinguish web verification, missing web login, subscription access denial and workspace mismatch, with Chinese and English guidance.
- Stop consecutive retries when web verification is required, reduce background retries and coalesce concurrent reads for the same account. Preserve previously read dates after failures.
- Include the launch fallback and regular-account/API login isolation fixes from 1.2.149.

## 验证说明 / Verification

相关订阅读取、后台状态、主界面、悬浮窗和账号状态回归测试通过。用户手动完成网页验证后，新版读取函数已通过真实工作空间账号的只读验证，成功返回套餐、到期日和续费日。未进行模型生成、额度唤醒或重置卡兑换；程序不会绕过网页验证。

Focused subscription, state, account UI and floating-window regressions passed. After the user manually completed web verification, the updated reader successfully returned the plan, expiration and renewal dates for the real workspace account. No model generation, quota wakeup or reset-credit redemption was performed. Web verification is not bypassed.
