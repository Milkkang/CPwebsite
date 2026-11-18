# Phase 1 — 后端骨架与部署流程

日期：2026-11-18。当前状态：待线上验收；不会进入 Phase 2，直到验收通过且用户明确 Approved Phase 1。

## 交付内容

- 现有 cpwebsite Worker 增加 GET/HEAD /api/health；同域，无须跨域配置。
- 未知 API 返回 JSON 404；健康接口不支持的方法返回 JSON 405/Allow；统一请求 ID、no-store 和通用错误结构。
- 日志只记录随机请求 ID、方法、固定路由标签、状态及耗时；不记录查询参数、用户路径、请求体、Cookie、令牌或异常详情。平台日志关闭 invocation logs 并启用查询参数脱敏。
- 保留原生前端及全部 dist 文件，构建检查逐文件比较字节。商品、会员、购物车和后台写入仍沿用现有 localStorage，未连接业务数据库或支付。
- GitHub 分支/PR 自动检查；Cloudflare Builds 在测试及打包成功后部署同一份预构建产物；npm lock 固定工具版本。
- 配置使用 cloudflare.config.ts；无原有 Wrangler 配置文件，按 Cloudflare CLI 指引使用 cf。Cloudflare Builds 的 GitHub main 连接、Worker、域名和 R2 保留。

## 验证

| 项目 | 状态/证据 |
| --- | --- |
| API 单元测试 | 本地 4 项通过：健康检查、方法/API 边界、静态转发、日志脱敏 |
| 原商品回归 | 通过：编辑持久化及验证、R2 替换、首页设置、分类、30/50/100 分页 |
| 生产构建 | 本地通过；全部原有页面及图片字节一致；ASSETS 和 /api 路由配置验证通过 |
| GitHub 分支检查 | 待执行 |
| 正式域名及 API | 待部署验证 |
| 线上回滚演练 | 待执行 |

健康接口只证明 Worker 在运行，不声称 Supabase/Resend/Stripe 已接通。

## 配置与数据影响

只增加 Worker 代码和 ASSETS 绑定；不创建业务表，不迁移浏览器数据，不发送邮件，不调用支付，不改变 R2 图片。
服务端凭据待在部署后的 Runtime Variables and Secrets 中安全配置；不放在 Builds。SUPABASE_SECRET_KEY、RESEND_API_KEY、STRIPE_SECRET_KEY 的值不进入源码或聊天。具体 Auth 回调、SMTP 和 webhook 验证依后续阶段完成。

## 限制及风险

- cf 1.0.0-rc.1 和 Cloudflare Vite plugin 2.0.0-rc.1 为官方当前候选版本，已固定版本。生产运行时为普通 ES Module，无这些构建依赖。
- npm audit 报告 picomatch <=4.0.7 ReDoS（GHSA-fc5q-39xc-vjpf），连同 vite/tinyglobby/fdir/plugin 共 5 条高危依赖记录；查询时最新 picomatch 4.0.7 尚无修复。仅影响受控源码的构建过程，不打包到 Worker、不接受买家提供 glob；不得将此报告成零告警，发布修复后需更新锁文件并重测。
- 尚未进行会员、订单或支付验收，Stripe 仍为 sandbox；未升级任何付费套餐。

## 回滚

阶段前 GitHub main：dbfc550fd6063cb6b3ff362b21b0d1c7a31d48b6。
阶段前 Cloudflare 版本：cffc5e9f-1ad2-44e9-afc4-f1e305097162。

1. Cloudflare cpwebsite → Deployments，选择阶段前版本回滚至 100%。原网站恢复，/api/health 会恢复为不存在。
2. 线上回滚不回滚外部数据；本阶段无数据库变更。不要删除 R2 或 Supabase 项目。
3. 持久代码回退：使用 Git revert 还原本阶段合并提交并通过 PR；同时恢复 Builds build command 为空，deploy command 为 npx wrangler deploy，避免旧代码使用新构建命令。
4. 恢复本阶段：将验证过的本阶段 Worker 版本重新部署至 100%，并检查首页和 /api/health。

发布证据与最终版本在验收完成后补充。
