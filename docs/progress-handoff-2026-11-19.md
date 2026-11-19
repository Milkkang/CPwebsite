# CP Value Mart 进度与交接报告（2026-11-19）

## 项目入口

- GitHub（唯一权威代码源）：<https://github.com/Milkkang/CPwebsite>
- 权威分支：`main`
- 本报告编写时的主分支提交：`62c7ae379e14a4d868cc59b13f49c9c80eda8776`
- 生产网站：<https://cpvaluemart.com>
- 技术栈：原生 JavaScript、Cloudflare Worker、Cloudflare Static Assets、Supabase、Stripe sandbox
- 本地目录不固定。新电脑或手机上的 Codex 应重新克隆 GitHub 仓库，不应依赖旧设备的绝对路径。

## 阶段状态

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| Phase 0 | 已完成 | 授权、资源和安全边界已建立。 |
| Phase 1 | 已批准 | Worker、正式域名、CI/CD、错误处理和日志已接通。 |
| Phase 2 | 已批准 | 678 个 SKU、11 个分类及目录 API 已迁移。 |
| Phase 3 | 已批准 | 注册、验证、登录、资料、地址、密码和管理员权限已完成。 |
| Phase 4 | 已批准（1 项延后） | 共享数据与会员购物完成；断网保存人工检查按用户要求延至 Phase 8。 |
| Phase 5 | 已批准 | Stripe sandbox 测试结账、订单、webhook、库存和购物车回写已完成。 |
| Phase 6 | 未开始 | 交易邮件、队列、重试、送达事件与后台补发。 |
| Phase 7 | 未开始 | 后台履约、追踪、取消、测试退款和回库。 |
| Phase 8 | 未开始 | 全链路验收、恢复演练和运维交付。 |

## 最近完成的工作

### Phase 5 Stripe sandbox 订单闭环

- 仅允许已验证会员使用已保存的新加坡地址结账。
- 服务端重新计算 SGD 价格、MOQ、库存、配送费和优惠。
- Stripe 仅接受测试凭据和 `livemode=false` 事件。
- webhook 验证签名、订单、Checkout Session、金额和币种后，才更新付款、库存和购物车。
- 验收订单 `CVM-1003` 已验证为 `paid` / `Processing`，只有一条 webhook 记录及一条匹配库存流水，会员购物车随后清空。
- 完整证据见 `docs/phase-5-acceptance.md`。

### 购物与收藏修复

- 修复 Stripe 返回后购物车未及时刷新的问题。
- 登录启动不再重复合并旧浏览器购物车，避免每次刷新数量增加。
- 访客不能加入购物车，旧访客购物车会在加载会员数据前清除。
- 访客点击 Saved Item／心形按钮会进入登录页，不再把收藏写入本地浏览器。
- 登录用户继续通过 `/api/shopping` 保存或取消收藏。

### Cloudflare Workers Preview 修复

- 项目使用 `cloudflare.config.ts` 和 `cf@1.0.0-rc.1`，不是 Wrangler 配置项目。
- 原失败命令 `npx wrangler preview` 与项目配置体系不匹配。
- 未建立第二套 Wrangler 配置；`package.json` 已增加 `preview: "cf previews deploy"`。
- Cloudflare Preview deploy command 已改为 `npm run preview`，生产构建和部署命令未改变。
- Preview URL：<https://fix-workers-preview-command-cpwebsite.milkkang93.workers.dev>

### 最近发布

- PR：[#16 Fix Workers Preview and require sign-in for saved items](https://github.com/Milkkang/CPwebsite/pull/16)
- 合并提交：`62c7ae379e14a4d868cc59b13f49c9c80eda8776`
- Cloudflare 生产构建：`b74e6070-b1e2-4188-b1c2-a9c16badb9e1`，结果 `success`
- 生产首页和 `app.js` 返回 HTTP 200，线上代码已确认包含访客收藏登录跳转。

## 当前验证结果

- `npm test`：38 项通过。
- `npm run build`：通过。
- `npm run test:runtime`：2 项通过。
- `git diff --check`：通过。
- GitHub Phase checks、Cloudflare Preview 和主分支生产构建均通过。
- 生产 `/api/health` 返回 HTTP 200，应用阶段为 Phase 5。

## 安全边界

- Stripe 必须保持 sandbox/test mode；不得配置 live key 或发起真实扣款。
- 测试订单不得计入真实营收。
- Secret 只放平台受保护配置，不得写入 GitHub、文档、日志或聊天。
- 不读取、输出或修改真实地址、密码、会话令牌、验证链接或密钥值。
- 数据库迁移是加法迁移。代码回滚不得删除订单、webhook、库存流水或会员购物数据。
- Preview URL 默认公开，不应在 Preview 中展示敏感生产数据。

## 遗留事项

1. Phase 4 后台断网保存与恢复重试未人工执行；用户要求延至 Phase 8，不能标记为通过。
2. Phase 5 只有测试支付；交易邮件属于 Phase 6，尚未开始。
3. 后台履约、追踪、取消和测试退款属于 Phase 7。
4. 测试订单必须持续与未来真实订单及营收统计隔离。

## 下一步

下一位开发者应先阅读 `docs/github-development-workflow.md`，从最新 `origin/main` 建立独立分支或工作树，然后开始 Phase 6 设计。Phase 6 至少包括邮件任务持久化、幂等键、有限重试、送达/退信/投诉 webhook、管理员补发和测试收件人限制。未获得明确的 `Approved Phase 6` 前不得进入 Phase 7。

## 回滚参考

- 本报告编写时的代码发布点：`62c7ae379e14a4d868cc59b13f49c9c80eda8776`。
- Phase 5 记录中的前一 Worker 恢复版本：`b62d3ac9-0e6b-4d22-8e22-db8c8c558bfa`。
- 回滚代码不等于回滚数据。任何破坏性数据库回退都必须先备份并另行制定迁移计划。

