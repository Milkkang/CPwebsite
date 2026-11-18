# Phase 2 — 数据库与商品迁移

状态：技术验收通过，等待用户验收并明确 Approved Phase 2。Phase 1 已于 2026-11-18 获用户 Approved Phase 1；未开始 Phase 3。

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
| GitHub 分支自动检查 | 通过：[导入分支 44254216431](https://github.com/Milkkang/CPwebsite/actions/runs/44254216431)、[运行时修复 44255002445](https://github.com/Milkkang/CPwebsite/actions/runs/44255002445)；npm ci/test/build/test:runtime 全部成功 |
| 正式迁移及重复导入 | 通过：远端迁移 20261118064358；重复执行 seed 后仍为 678 商品/678 库存流水；另在回滚事务内改价后重跑，验证价格不被覆盖 |
| DB 数量/内容一致性及权限 | 通过：678/678 SKU 精确匹配全部 17 个源字段；0 差异；事务测试通过金额/MOQ/库存约束、匿名及会员越权拒绝；夹具回滚 |
| 正式 API 筛选、排序、分页 | 通过：678 SKU 全字段一致；30/50/100；7 页无重复遗漏；搜索/品牌/分类/价格排序/名称请求；空结果、越界页；400/404/405/HEAD；request ID 与 no-store |
| 原前端保持正常 | 通过：1182×1371 首页 10 商品/5 列、列表 30/50/100、翻页刷新、分类直接加购、商品详情；390×844 手机无横向溢出；无页面脚本错误；首页及所有 dist 文件未改 |
| Supabase 安全/性能 advisors | 无 ERROR/WARN。安全 INFO 为四张私有表无策略（明确拒绝客户端访问）；性能 INFO 为四个新建索引尚未使用 |

## 恢复方式

- 代码回退点：Phase 1 GitHub b8c6f50c63bb7c0dbdc6986b3a20c25233096f25；Phase 1 Worker edb7a92c-3ae0-480d-8e9d-a78e2cac1018。后者不含本阶段新增的 publishable Secret；本阶段另记录了保留该只读 Secret 的 Phase 1 代码版本 0bd93b75-6639-4979-96e5-b676e32a7f32，优先以此作为运行时回退点，避免 Secret 版本变化阻止回退。回退不改数据库，恢复 Phase 2 时保留该 Secret。
- 数据库是增量新增，不删除旧数据。Worker 回退无需删除新表；前端从未切换数据源。
- 迁移 SQL 在 supabase/migrations；MCP apply_migration 记录远端迁移历史。seed SQL 独立版本化且可重复运行；核验 SQL 在 supabase/phase-2-verification.sql，事务回滚全部测试夹具。`node scripts/migration/content-check.mjs` 生成全部字段精确对比 SQL（只读），预期 expected_rows=matched_skus=database_rows=ledger_rows=678，mismatched_rows=0。
- 本阶段前 public schema 为空。若需在新的空项目重建：先应用迁移，再执行种子 SQL，再跑核验 SQL，检查报告数量/hash。不得在已有后续订单/库存变更后用本阶段初始 seed 当完整备份，也不得用 DROP TABLE 撤回代码。
- 本阶段数据可由仓库种子完整重建；独立持续备份与恢复演练仍属于 Phase 8，不声称 Free 套餐自带生产备份。

## 已知限制

当前 678 行目录采用字面子串搜索；分类/品牌有索引。规模扩大后需按实际查询计划加入 trigram 或全文索引。未开放后台写入接口；管理员角色为空，Phase 3 仅授予已验证指定邮箱。尚无真实订单或会员。

服务端 SUPABASE_SECRET_KEY、Resend/Stripe 运行凭据仍按 Phase 0 顺延记录，当前只读目录不需要它们；后续鉴权、支付、邮件阶段必须分别配置并验证。Stripe 维持 sandbox，未发邮件、未交易、未升级套餐。Phase 1 构建工具的已记录上游告警未因本阶段发生改变。

## Advisor 说明

私有表 RLS 无策略采用 PostgreSQL 默认拒绝语义，同时撤销 anon/authenticated 表权限；不为了消除提示增加读取策略。[RLS 无策略检查说明](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)。初始阶段小表/尚未启用后台流水查询，保留分类、品牌及外键索引，按后续真实负载复查，[未使用索引提示](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)。

## 部署及运行时检查

Cloudflare Builds 当前 build command 为 `npm test && npm run build && npm run test:runtime`，deploy command 为 `npm run deploy`。最后一步是 Miniflare/workerd 真实运行时测试：模拟 Supabase 正常读取返回 200，同时模拟 302 跳往其他域，验证拒绝跳转且不向目标发出请求。测试凭据是假值，不接触实际平台 Secret。

初次线上验收发现 Workers 不支持 Fetch 的 redirect:error；已改成 manual 并拒绝非 2xx。该故障没有影响仍使用原数据源的购物页面，验收在修复后重做。运行时行为依据 [Cloudflare Request 文档](https://developers.cloudflare.com/workers/runtime-apis/request/)。恢复 Phase 1 旧源码时，须同时把 Builds build command 恢复为 `npm test && npm run build`，否则旧版本没有 test:runtime 脚本；恢复 Phase 2 再使用上述完整命令。

## 最终发布证据

- [主实现 PR #2](https://github.com/Milkkang/CPwebsite/pull/2)：最终功能提交 10124b18294ed4d4e265579116ba4868af8272b7；合并 48727d40dacfebe919d09906662cd8af281721d9。
- [运行时修复 PR #3](https://github.com/Milkkang/CPwebsite/pull/3)：提交 e639d365218b5ddf18361d01fbcd7ae96579f2f2；最终功能合并 3dd4f6b0fafc474029cc4046c038a552c5d8d0d2。
- Cloudflare Builds 7872ba16-1fbf-443b-8da3-adf270592c5a：success；测试、构建、真实运行时测试、部署均通过。
- 正式 Worker 1e785bba-13f8-40e5-aa31-ef22f548320a，100%；deployment 1d608ce2-82ce-42ad-b25a-1f139632ae66。
- Supabase 迁移版本 20261118064358，phase2_catalog_foundation；本地迁移文件与远端生成版本对齐。
- 核验：expected_rows=678，matched_skus=678，mismatched_rows=0，database_rows=678，ledger_rows=678；库存合计 67800；匿名/普通会员写入和私有数据读取拒绝；所有测试夹具及改价测试回滚。
- 数据集 SHA-256 a420393a2588812738e7eae99788d643c53b040d2e1650a7a5815e75e807be72。
- 首页 SHA-256 3cebc4a6169c356d295419a642d85891047deac2546d7a40ccf3c1af60ca9a6f，与 Phase 1 相同。
- 只读重现线上 API 验收：从仓库运行 `node docs/phase-2-live-check.mjs`；该脚本针对本阶段初始目录基线，后续有意编辑目录后应更新验收预期。

验收链接：[全部商品 API](https://cpvaluemart.com/api/products)、[每页 50、第二页](https://cpvaluemart.com/api/products?size=50&page=2)、[分类筛选](https://cpvaluemart.com/api/products?category=personal-care)、[商品详情](https://cpvaluemart.com/api/products/13M-01-01)、[公开配置](https://cpvaluemart.com/api/config)、[原前端](https://cpvaluemart.com/#/)。

新增资源只有上述 8 张表、迁移及 678 条初始商品/库存流水、11 分类、1 首页配置、1 配送规则、2 优惠券和 1 导入记录；管理员角色为空。没有订单/会员/邮件/付款测试数据，没有新增项目或付费升级。没有未解决的 Phase 2 关键故障；运行时高权限 Secret、Auth、SMTP、支付和交易邮件等待对应阶段。
