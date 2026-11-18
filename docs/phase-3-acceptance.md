# Phase 3 — 会员与管理员鉴权

状态：进行中，未通过，不进入 Phase 4。Phase 2 已获 Approved Phase 2。

## 配置核对

- 用户已保存 Cloudflare Runtime SUPABASE_SECRET_KEY；仅检查过名称，未读取值；Builds 为空。
- 用户已保存 Resend SMTP（orders@notify.cpvaluemart.com，CP Value Mart，smtp.resend.com，465，resend，受限 notify 发信 key）。未读取 SMTP 密码；真实送达待验收。
- Site URL=https://cpvaluemart.com；精确回调 /auth/confirm、/auth/reset；注册/重置模板使用 TokenHash。原生 Chrome 登录会话已核对两套模板及 Confirm email=on、Email=enabled、匿名登录关闭。

## 实现

Auth 密码、注册、重发验证、重置请求与 TokenHash 验证均由同域 Worker 代理到 Supabase Auth。密码由用户自行输入，不进入日志、源码或浏览器存储。登录后 Cookie 是随机 256 位不透明值；HttpOnly、Secure、SameSite=Lax、__Host-、Path=/。数据库仅保存 Cookie 哈希，Auth access token 以 AES-GCM 加密（密钥从服务端 Secret 派生）；不存储/返回 refresh token。

每次私有 API 请求检查网站会话、Auth session 当前存在性、到期时间、邮箱验证及封禁状态。退出先删除网站会话，再尽力撤销上游；上游故障不能恢复本网站权限。密码更新成功后撤销该用户全部网站会话。恢复会话不能读会员资料或使用后台，只能完成密码更新及退出。

会话最长 1 小时且不超过 Supabase access token 剩余寿命，刷新页面保留登录；到期后重新输入密码。暂不提供长期记住登录/自动 refresh token；Secret 轮换需要用户重新登录。后台权限来自实时数据库 admin_roles 且仍要求指定已验证邮箱，不信任客户端 role 或 user_metadata。

buyer_profiles / buyer_addresses 采用所有者 RLS + 有效 Auth session 检查；不能读取/改写其他用户或转移 user_id。server_sessions / auth_rate_limits 不对客户端授权。私有 schema 中窄范围 SECURITY DEFINER helper 仅供指定角色调用；公开 wrapper 为 SECURITY INVOKER。认证邮件/登录请求有数据库原子限流，来源 IP/邮箱组合只以带服务端秘密的哈希保存，过期清理，不写请求日志。

GET 回调页面只显示确认按钮，不自动消耗 TokenHash；no-store、no-referrer 和 CSP，加载后立即移除地址栏令牌，只保留内存。固定同源 Origin 校验防止跨站表单请求。所有上游重定向拒绝跟随；错误不返回 SMTP/令牌详情。

前端移除旧输入名字即登录/模拟登录按钮；localStorage 中的 account 始终忽略且不再持久化。后台界面登录保护，后台操作前实时检查 /api/admin/access；尚无商品后台写入 API，Phase 2 的业务表客户端写权限保持关闭。后台商品设置在 Phase 4 接通共享写入。购物目录/分页/样式沿用原站；暂时关闭模拟提交订单入口，购物车保留，真正订单/测试付款在 Phase 5 开放。

## 接口

POST /api/auth/signup、login、recover、resend、verify、password、logout；GET /api/auth/session。
GET/POST /api/profile；GET/POST /api/addresses；POST /api/addresses/:id（action=delete）。GET /api/admin/access；其余后台接口先鉴权再 404。

## 验收

| 项目 | 状态 |
| --- | --- |
| 单元/原商品回归 | 本地 16 项 + 原商品回归通过 |
| 真实 Workers 运行时 | 通过：目录请求、重定向拒绝、Auth AES-GCM 会话、回调 HTML/安全响应头两项 workerd 测试 |
| 数据库 RLS / 双用户 / 撤销 | 通过：迁移 20261118074149；两用户隔离、禁止转移所有权、metadata 伪管理员无效、私有会话不可读、Auth 撤销后旧 JWT 无效、限流；夹具全部回滚 |
| GitHub 分支检查 | 首轮通过 [Actions 44260687108](https://github.com/Milkkang/CPwebsite/actions/runs/44260687108)，最终迁移文件名与远端记录对齐 |
| 正式域名部署与桌面/手机 | 待执行 |
| 注册真实送达及验证 | 待用户自行输入密码，测试只发 milkkang93@gmail.com |
| 错误/过期链接及错误密码 | 待线上验收 |
| 密码重置真实送达及改密 | 待用户自行输入新密码 |
| 首位管理员 | 未授予；只能在指定邮箱被 Auth 验证后授予 |

## 数据与回退

新增四张表及受限函数，不更改现有 678 商品。SQL 测试只用 .invalid 合成身份，在事务内全部回滚，不调用邮件 API。真实注册由用户在正式网站完成；仅指定管理员/验收邮箱。未发未知邮件、不升级套餐、不操作 Stripe。

阶段前 GitHub main 962a33a0708677283797e06299ef080c3ecf0eb8；Phase 2 Worker 1e785bba-13f8-40e5-aa31-ef22f548320a（后续记录含当前 Secret 的回退点）。旧阶段模拟后台没有真实写 API，但回退会恢复原预览登录行为；不将回退作为安全鉴权替代方案。数据库新增表可以保留，不 DROP，不清除会员数据；关闭新注册或回退需保留已有账号及邮件设置记录。

本阶段不代表订单/收藏/购物车已跨设备同步。Supabase Free 独立备份及 Phase 1 构建依赖告警仍按此前报告记录。

## 当前检查证据

本机 Chrome 已确认新登录和注册表单正常显示，未登录访问后台被拦截；无效回调显示重发入口，地址栏 TokenHash 已移除。未在本机开发环境配置生产密钥，也未在开发环境提交注册。

Supabase security advisor 无 ERROR/WARN；6 个 INFO 为 server_sessions/auth_rate_limits 及此前私有表明确采用 RLS 默认拒绝、无客户端策略，不增加读取策略消除提示。[检查说明](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)。

已记录阶段前仍含最新服务端 Secret 的 Worker 恢复点 82e52f9a-3bfc-4150-a634-f4bce80b2e09，原 deployment 9761ed17-6775-45cc-aaf6-c1813eab9836。
