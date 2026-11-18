# Phase 1 — 后端骨架与部署流程

日期：2026-11-18。当前状态：技术验收通过，等待用户验收并明确 Approved Phase 1；未进入 Phase 2。

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
| GitHub 分支检查 | 通过：[PR #1](https://github.com/Milkkang/CPwebsite/pull/1)、[Actions run 44250870224](https://github.com/Milkkang/CPwebsite/actions/runs/44250870224)，npm ci/test/build 全部成功 |
| 正式域名及 API | 通过：https://cpvaluemart.com/api/health 200；未知 API 404 JSON；POST health 405；首页 SHA-256 与原版一致 |
| 正式浏览器验收 | 通过：1182×1371 桌面首页 10 产品/5 列，列表 30/50/100、翻页及刷新、分类直接加购、商品页；390×844 手机无横向溢出；无 pageerror |
| 线上回滚演练 | 通过：旧版本 100% 后 health 404、首页哈希一致；恢复新版本 100% 后 health 200。回滚部署 9d03ea3b-a1ca-4284-a918-a44c7d0a6f5f；恢复部署 34ec0d6c-3a21-4458-85f4-8b0312d465b7 |

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

## 发布证据

- 功能提交：258d95d76debf456c33b6d4ce5ebfc94d9a4a2fb；合并提交：96dbc0c59d64ed18ab22effdfca8961e806be78f。
- Cloudflare Builds：7273ab57-feb9-4c64-be1e-d77a322b30f1，success；Node 24.22.1；测试、构建、部署成功。
- Worker 功能版本：edb7a92c-3ae0-480d-8e9d-a78e2cac1018，演练后恢复 100%。
- 首页 SHA-256：3cebc4a6169c356d295419a642d85891047deac2546d7a40ccf3c1af60ca9a6f，部署前/后/回滚一致。
- 线上运行设置核验：ASSETS 绑定存在；redact_query_string=true；invocation_logs=false；无运行时 Secret。
- 后续仅 docs/** 验收记录变化不触发 Cloudflare 重复发布；功能提交及线上资源不变。

## 下一步人工凭据配置

现在 Worker 已有后端代码，可在 Cloudflare cpwebsite → Settings 找到运行时 Variables and Secrets（避开 Builds）。按 Phase 0 顺延事项配置 SUPABASE_SECRET_KEY、RESEND_API_KEY、STRIPE_SECRET_KEY；最后一项只能使用 sandbox/test key。保存时不要将值发到聊天。只核验名称不读取值；Auth/SMTP 和 webhook 在对应阶段验收。当前健康检查不依赖这些凭据，因此不以 200 推断服务接通。

## 参考

Cloudflare 当前配置指引：https://developers.cloudflare.com/cf/agents/ 、https://developers.cloudflare.com/cf/projects/cloudflare-config/ 。回滚边界：https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/ 。
