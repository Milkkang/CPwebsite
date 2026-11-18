# Phase 2 — 数据库与商品迁移

状态：进行中。Phase 1 已于 2026-11-18 获用户 Approved Phase 1。完成技术验收后仍等待 Approved Phase 2，不开始 Phase 3。

## 数据来源与确认

用户明确确认“没有，按仓库默认数据导入”，不存在需要保留的浏览器本地修改。输入是 GitHub 的 dist/catalog.js，通过现有 dist/store.js 的 listing 转换生成 678 个 SKU（137 组），不是模拟订单、账号或购物车。全部 R2 原图地址保留。

[导入前报告](../data/phase-2-import-report.json)记录数量、分类、金额、MOQ、库存、图片及数据哈希。默认运费 SGD 390 分、满 5000 分免运；WELCOME5 满 2000 分减 5%；SHIPFREE 满 3500 分免运。金额用整数分，百分比 amount 保持整数百分比。food-pantry、snacks-drinks 各 0 个商品属于源目录现状。

数据报告字段检查通过不等同于逐个验证远端图片可下载；不更改任何图片路径。未验证的客服收件地址不纳入公开设置。

## 实现

- 新增 categories、products、inventory_movements、homepage_config、delivery_rules、coupons、admin_roles、import_runs 八张表。
- SKU 唯一，id=sku，一规格一行；SGD 整数分；库存/预留/MOQ 检查约束；版本号更新触发器。
- 所有表开启 RLS；匿名和普通会员只能读已发布商品、分类、首页及有效配送规则。没有客户端写权限。优惠券、库存流水、管理员角色、导入记录不公开。
- read_catalog 为 SECURITY INVOKER，只读并受 RLS 约束，绑定参数而非拼接 SQL；单语句快照计数与分页，SKU 稳定排序；30/50/100，上限 100，越界页夹到最后一页。
- 同域 GET/HEAD：/api/products（q/category/brand/sort/size/page）、/api/products/:sku、/api/categories、/api/config。
- Worker 用最低权限的 Supabase publishable key 执行公开读取，key 只保存在 Cloudflare Runtime Secret SUPABASE_PUBLISHABLE_KEY；不使用 service secret 绕过 RLS；URL 是非敏感项目配置。对数据库故障返回 503，不把目录静态回退伪装成成功。
- 前端数据源保持原样，正式切换在 Phase 4。无会员/订单/支付/邮件实现。

## 导入及差异核对

运行 `npm run data:prepare` 验证并生成报告及 `data/phase-2-seed.sql`。该事务使用 advisory lock，INSERT ON CONFLICT DO NOTHING：重复导入不覆盖任何已有业务行，只有新插入商品才产生唯一初始库存流水。预期源版本初始 678 条商品及 678 条流水；重新导入后仍应一致。

对浏览器差异，可在正式网站 DevTools 执行 scripts/migration/export-browser.js，将下载的业务 JSON 保存在仓库外；`node scripts/migration/compare.mjs /absolute/path/export.json` 仅输出 SKU/差异字段及配置变化标记，不写数据库。导出不包含账号、订单、地址、会话或购物车；本次用户已确认没有差异，无需导入本地数据。

## 验收清单

| 检查 | 结果 |
| --- | --- |
| 导入前字段与唯一性 | 通过，678 listing，无错误；stock 67800；MOQ 3 |
| API/差异工具/前端单元回归 | 本地通过，11 项新旧单元测试及原商品回归 |
| GitHub 分支自动检查 | 待执行 |
| 正式迁移及重复导入 | 待执行 |
| DB 数量/内容一致性及权限 | 待执行 |
| 正式 API 筛选、排序、分页 | 待执行 |
| 原前端保持正常 | 待执行 |
| Supabase 安全/性能 advisors | 待执行 |

## 恢复方式

- 代码回退点：Phase 1 GitHub b8c6f50c63bb7c0dbdc6986b3a20c25233096f25；Phase 1 Worker edb7a92c-3ae0-480d-8e9d-a78e2cac1018。后者不含本阶段新增的 publishable Secret；回退不需要该 key，恢复 Phase 2 时保留/重加 Secret。
- 数据库是增量新增，不删除旧数据。Worker 回退无需删除新表；前端从未切换数据源。
- 迁移 SQL 在 supabase/migrations；MCP apply_migration 记录远端迁移历史。seed SQL 独立版本化且可重复运行；核验 SQL 在 supabase/phase-2-verification.sql，事务回滚全部测试夹具。
- 本阶段前 public schema 为空。若需在新的空项目重建：先应用迁移，再执行种子 SQL，再跑核验 SQL，检查报告数量/hash。不得在已有后续订单/库存变更后用本阶段初始 seed 当完整备份，也不得用 DROP TABLE 撤回代码。
- 本阶段数据可由仓库种子完整重建；独立持续备份与恢复演练仍属于 Phase 8，不声称 Free 套餐自带生产备份。

## 已知限制

当前 678 行目录采用字面子串搜索；分类/品牌有索引。规模扩大后需按实际查询计划加入 trigram 或全文索引。未开放后台写入接口；管理员角色为空，Phase 3 仅授予已验证指定邮箱。尚无真实订单或会员。

服务端 SUPABASE_SECRET_KEY、Resend/Stripe 运行凭据仍按 Phase 0 顺延记录，当前只读目录不需要它们；后续鉴权、支付、邮件阶段必须分别配置并验证。Stripe 维持 sandbox，未发邮件、未交易、未升级套餐。Phase 1 构建工具的已记录上游告警未因本阶段发生改变。
