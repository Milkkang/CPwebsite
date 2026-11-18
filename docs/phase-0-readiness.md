# Phase 0 — 授权及资源验收

检查日期：2026-11-18（Asia/Singapore）。状态：用户于 2026-11-18 明确“同意调整，进入 Phase 1”。运行时 Secret/SMTP/Auth 配置顺延到后端骨架部署之后；其余未核实项保持记录，不视为已完成。

## 已核实

| 项目 | 结果 |
| --- | --- |
| GitHub | Milkkang/CPwebsite；main；连接具备 pull/push/admin 权限；仓库为 public |
| Cloudflare | 正确账户；cpwebsite Worker 已有静态资源；cpvaluemart.com 和 www.cpvaluemart.com 均绑定 production |
| R2 | cpvaluemart 桶存在；现有 pub-aff260a936bf43069b7b2903e0af2f9c.r2.dev 已启用 |
| 部署 | GitHub CPwebsite main 自动部署；root /；build command 空；deploy command npx wrangler deploy |
| 当前恢复点 | Cloudflare 版本 cffc5e9f-1ad2-44e9-afc4-f1e305097162，流量 100%；本地 main dbfc550 |
| Worker Secrets | 当前为零；尚未配置任何运行时凭据 |
| Resend | cpvaluemart.com、notify.cpvaluemart.com verified，sending enabled；存在两把命名 API key，但未取得其值、未配置到 Worker |
| Stripe | cpvaluemart sandbox，acct_1UYz9oDGR4SlocR3，livemode=false；连接不等同于后端已有 API key |
| 验收身份 | 管理员及测试收件人 milkkang93@gmail.com；尚未创建应用管理员角色 |

## 待完成及阻碍

- Supabase 已连接。用户已明确选择 CPValueMart（kkwgqphubjaveflyatsv）；创建报价 US$0/月；已创建 cpvaluemart-production（tfrfkvkjmaqnpxdhxumr），区域 ap-southeast-1，新加坡，状态 ACTIVE_HEALTHY。当前聊天本机浏览器仍不可用。
- Supabase API URL 已确认：https://tfrfkvkjmaqnpxdhxumr.supabase.co 。公开 key 查询已完成，值未输出至聊天或文件；Worker 仍未配置。服务端 secret 尚不可获取；尚无业务表、Auth 用户或迁移。public schema 检查为空，security advisors 无告警。
- Resend API/SMTP 运行时密钥、Stripe 测试 secret 与 webhook 签名凭据尚未配置。不可把连接工具权限当作部署运行时凭据。
- API webhook 端点实现属于后续阶段；本阶段仅准备和安全记录所需配置，不将尚不存在的端点报告为已验证。
- Cloudflare Billing API 返回 403；当前 OAuth 不覆盖该接口，不能确认账户现有套餐及账单。不申请不必要的广泛 Billing Write 权限；后续可由用户查看只读账单信息。
- 完整 DNS 列表未发现 _dmarc TXT。Resend 域名验证通过，但发送前还需复核 SPF/域名别名和 DMARC 配置；本阶段未改 DNS。
- Supabase 组织套餐已确认 Free，新项目创建成功；Free 项目的独立备份尚未配置。未核实 Resend 实际套餐及剩余额度。

## 费用及备份边界

- 不升级任何付费套餐，不新增付费服务。
- Supabase 官方公开 Free 限额为每项目 500 MB、最多两个活跃 Free 项目；不活跃项目可能暂停。Free 项目应安排独立导出备份，不视为已具备生产自动恢复保障。
- Resend 公开 Free 额度为每月 3,000 封、每天 100 封；实际账户套餐待核实。
- 所有额度以账户实际配置和最新官方页面为准，不能以公开 Free 额度推断当前账户套餐。
- Stripe 仅测试，禁止切换 live。网站当前仍为原有预览，未接通真实订单或支付。

资料：https://supabase.com/pricing 、https://supabase.com/docs/guides/platform/backups 、https://resend.com/pricing

## 恢复与数据影响

已创建一个空 Supabase 项目；没有升级套餐，没有创建业务表或迁移。未改线上网站、DNS、部署触发器、平台 Secrets；未发送邮件，未执行交易。现有网站恢复点保持不变。新项目目前不接收网站流量，无须为撤回网站变更而删除项目。

## 剩余验收

1. 已完成：Supabase 连接、组织确认、US$0/月报价及新加坡项目创建。
2. 创建正式项目并确认区域、套餐、备份能力。
3. 按最小权限安全配置运行时凭据，仅检查名称/存在性，不输出值。
4. 验证 Auth 回调、SMTP、DNS、部署权限及实际配额。
5. 完成报告；用户明确 Approved Phase 0 后才进入 Phase 1。


## 当前工具能力及人工配置入口

- Supabase 连接可查询公开 API key、操作数据库，但无 Auth 配置或服务端 Secret 获取接口；不以 SQL 绕过控制平面权限。
- Resend 创建 key 工具要求展示 token，与本项目“密钥不进入聊天”要求冲突，因此未调用创建；需在平台内创建仅 notify.cpvaluemart.com 发信权限的 key。
- Stripe API 连接可操作 sandbox 资源，不提供网站运行时 secret key。
- 当前无法访问本地 Chrome；平台密钥需通过安全界面直接配置，不粘贴到聊天、GitHub 或本地跟踪文件。

待填 Cloudflare cpwebsite Runtime Secrets：

| 名称 | 来源/要求 |
| --- | --- |
| SUPABASE_SECRET_KEY | 新项目 API Keys 中服务端 Secret key，仅服务端使用 |
| RESEND_API_KEY | 限定 notify.cpvaluemart.com 的 sending_access key |
| STRIPE_SECRET_KEY | cpvaluemart sandbox 的测试 secret key，禁止 live |
| STRIPE_WEBHOOK_SECRET | Phase 5 端点创建时配置；当前无有效后端端点，不虚报已验证 |
| RESEND_WEBHOOK_SECRET | Phase 6 端点创建时配置；当前不虚报已验证 |

Supabase Auth 设置待配置：Site URL=https://cpvaluemart.com；具体确认/重置回调路径需在 Phase 1/3 路由确定后精确加入，不使用宽泛通配；SMTP 使用 Resend 平台显示的 host/port/username，密码为受限发信 key；发信地址 orders@notify.cpvaluemart.com。

用户已批准上述顺延并进入 Phase 1；没有将缺失的运行时凭据、Auth 或 SMTP 报告为已验证。
