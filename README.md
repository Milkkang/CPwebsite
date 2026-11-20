# CP Value Mart

CP Value Mart 新加坡杂货商城，含会员商店与管理员后台。开发规则见 [AGENTS.md](AGENTS.md)。

## 技术架构

- `dist/`：原生 JavaScript 前端与静态资源（现有实现不是 React）。
- `src/`：Cloudflare Worker，同域 `/api/*`；`cloudflare.config.ts` 使用 cf CLI。
- Supabase：正式业务数据、Auth、RLS 与受控服务端 RPC。
- Cloudflare R2：商品图片；保留现有 URL。
- Stripe：仅 sandbox/test 支付；Resend：认证邮件及 Phase 6 交易邮件。

此目录源自 Sites 设计导出，`.openai/hosting.json` 仅保留原始配置。静态 HTTP server 只能预览资源，不能替代 Worker/API 本地开发。

## 本地开发和验证

Node 版本：22.23+（22.x）、24.22+（24.x）或 26.12+（26.x）；依赖以 lockfile 为准。

```sh
npm ci                 # 首次准备或依赖变化时
npm run dev            # Worker 和前端
npm test               # 语法、API/UI 回归及商品编辑检查
npm run build          # 打包并核对静态资源字节、Worker 配置
npm run test:runtime   # 构建后执行真实 Worker runtime 检查
```

按 [分级验证规则](AGENTS.md) 选检查，不为纯文档运行整套应用测试。定向测试示例：`node --test tests/catalog-api.test.mjs`；商品编辑：`node tests/product-editing.mjs`。

`npm run data:prepare` 会重新生成初始 seed/report，并非日常验证或数据库备份；仅在目录导入任务中使用。迁移、数据权限和恢复边界见对应验收记录。

## 环境配置（仅名称）

| 名称 | 用途与范围 |
| --- | --- |
| `SUPABASE_URL` | 非敏感项目配置 |
| `SUPABASE_PUBLISHABLE_KEY` | 公开目录访问的运行时绑定 |
| `SUPABASE_SECRET_KEY` | 仅服务端 Auth 与受控业务操作 |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Phase 5 测试支付与 webhook |
| `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET` | Phase 6 发信与事件验签 |
| `TRANSACTIONAL_EMAIL_TEST_RECIPIENTS` | 受保护测试收件人 allowlist |
| `TRANSACTIONAL_EMAIL_FROM`, `TRANSACTIONAL_EMAIL_REPLY_TO` | 交易邮件发件人与回复地址 |

以上名称由当前 `cloudflare.config.ts` 确认；代码存在绑定不表示生产配置或验收已完成。`ASSETS` 为静态资源绑定。凭据仅存平台运行时受保护配置，不提交值，不放 Builds 或浏览器；不要从生产导出 Secret 用于本地开发。

## CI 和部署

[GitHub Actions](.github/workflows/checks.yml) 在 main、`phase-*/**`、`dev/**` 和既有开发分支的代码 push 及 PR 上执行 `npm ci`、test、build、runtime；该工作流没有部署步骤；纯 Markdown/docs push 跳过应用 CI。

Cloudflare Builds 的 main 连接可自动部署既有 `cpwebsite` Worker。历史记录的构建命令为 `npm test && npm run build && npm run test:runtime`，发布为 `npm run deploy`（预构建产物）。发布前须核验平台当前触发条件和路径过滤，不能把历史 docs 跳过发布记录当作现行保证。

已授权的非破坏性发布在确认目标、检查和回滚路径后执行；高风险操作见 AGENTS。Preview 按需使用现有 `npm run preview`，不新增 Wrangler 配置。`GET /api/health` 仅证明存活，不能证明数据库、邮件、支付或验收已完成。

## 文档索引

- [当前状态](docs/STATUS.md)：唯一维护的当前进度入口。
- [运行、导入与恢复](docs/operations.md)：测试、Preview、生产发布、回滚与测试付款恢复。
- [协作流程](docs/github-development-workflow.md)：Git、分支、PR 与部署操作参考。
- [最终验收证据](docs/final-acceptance.md)：实际测试、生产 QA、清理及验证边界。
- [本次规则审计](docs/workflow-audit.md)：生效范围、历史冲突及验证范围。
- 验收原始证据：[Phase 0](docs/phase-0-readiness.md)、[Phase 1](docs/phase-1-acceptance.md)、[Phase 2](docs/phase-2-acceptance.md)、[Phase 3](docs/phase-3-acceptance.md)、[Phase 4](docs/phase-4-acceptance.md)。后续阶段的固定版本证据见 STATUS。
