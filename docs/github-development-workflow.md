# CP Value Mart GitHub 中心协作流程

GitHub 仓库 `Milkkang/CPwebsite` 是代码、文档和交接状态的唯一权威来源。任何电脑或 Codex 会话都应从 GitHub 开始，不依赖某台设备的旧目录、旧分支或聊天记录。

## 1. 新设备首次接手

确认设备已连接正确的 GitHub、Cloudflare、Supabase、Stripe 或邮件服务账户。不要把 Secret 粘贴到聊天或命令参数。

```bash
git clone https://github.com/Milkkang/CPwebsite.git
cd CPwebsite
git fetch origin --prune
git switch main
git pull --ff-only origin main
npm ci
npm test
npm run build
npm run test:runtime
```

然后阅读：

- `docs/progress-handoff-2026-11-19.md`
- 最新的 `docs/phase-N-acceptance.md`
- `cloudflare.config.ts`
- `.github/workflows/checks.yml`

若使用 GitHub Connector，先确认仓库为 `Milkkang/CPwebsite`；若使用 Cloudflare 插件，先只读检查目标 Worker 和 Builds 配置，避免误操作其他账户或生产资源。

## 2. 每次开始工作前同步

```bash
git switch main
git fetch origin --prune
git pull --ff-only origin main
git status --short --branch
git log --oneline --decorate -10
```

如果 `git pull --ff-only` 失败，说明本地 `main` 有分叉。不要强推、不要 `git reset --hard`。保留本地内容，从 `origin/main` 新建干净工作树：

```bash
git worktree add ../CPwebsite-task -b fix/short-task-name origin/main
cd ../CPwebsite-task
```

## 3. 一项任务一个分支

分支命名示例：

- `fix/saved-item-login`
- `fix/workers-preview-command`
- `feature/phase-6-email-jobs`
- `docs/update-handoff`

不要直接在 `main` 修改或推送。修改前先确认：

```bash
git status --short --branch
git diff origin/main...HEAD
```

## 4. 实现和验证

保持最小改动，不顺带改生产域名、Secret、Stripe live 配置或无关数据库对象。常规验证：

```bash
npm test
npm run build
npm run test:runtime
git diff --check
git status --short
git diff
```

涉及数据库时必须使用新增 migration，并先验证权限、RLS、幂等和回滚影响。涉及支付时只允许 Stripe sandbox。涉及 Cloudflare Preview 时使用项目脚本：

```bash
npm run preview -- --dry-run
```

## 5. 提交和上传

```bash
git add <明确的文件列表>
git commit -m "简洁描述本次改动"
git push -u origin <分支名>
```

若终端没有 GitHub 凭据，可使用连接的 GitHub 插件创建分支并上传文件；不要在聊天中提供 Personal Access Token。

## 6. 创建 Pull Request

PR 必须写明：

- 解决的问题和根因。
- 修改了哪些行为。
- 未修改哪些生产配置或数据。
- 执行过的测试及结果。
- Preview URL 和人工验收步骤。
- 数据库、支付、邮件或回滚风险。

PR 创建后等待 GitHub Actions 和 Cloudflare Preview。检查失败时先读取具体日志，不要重复盲目重试。

## 7. Preview 验收

Cloudflare Preview 当前通过 `npm run preview` 调用 `cf previews deploy`。确认：

- 构建对应正确的分支和提交 SHA。
- Build outcome 为 `success`。
- Preview 首页和相关 API 返回预期状态。
- 不在 Preview 执行破坏性生产写入。
- Preview URL 默认公开，不展示 Secret 或隐私数据。

需要人工确认的功能，应把明确步骤和预期结果交给用户。阶段功能只有在用户明确回复 `Approved Phase N` 后，才能进入下一阶段。

## 8. 合并和生产验证

只有在用户明确要求合并、检查通过且验收满足时才合并 PR。合并后：

```bash
git switch main
git fetch origin --prune
git pull --ff-only origin main
```

然后确认：

- GitHub `main` 指向预期合并提交。
- Cloudflare 主分支构建完成且 outcome 为 `success`。
- 生产首页和受影响 API 返回正常状态。
- 线上静态资源或 API 行为确实包含本次修复。
- 未发生意外的生产配置、路由、Secret 或数据变更。

## 9. 更新进度和交接

每个阶段或重要修复合并后，在同一仓库更新：

- `docs/progress-handoff-YYYY-MM-DD.md`
- 对应的 `docs/phase-N-acceptance.md`

至少记录 PR、合并 SHA、CI、Cloudflare Build/Deployment、测试结果、人工验收、遗留项和回滚点。不要记录 Secret、真实地址、密码、令牌或完整支付资料。

## 10. 多设备共同开发原则

- GitHub `main` 是真相，不以某台电脑的工作树为准。
- 聊天记录不是交接数据库；关键状态必须进入仓库文档。
- 每台设备开始前先 fetch/pull，结束前把完成的工作提交到分支并开 PR。
- 不共享未提交的本地修改；确需换设备时，先提交到临时分支并明确标记 WIP。
- 不在两台设备同时修改同一分支；不同任务使用不同分支。
- 合并后其他设备重新同步 `main`，不要复制整个旧项目目录覆盖新仓库。
- 冲突应在功能分支解决，禁止强推 `main`。

## 11. 当前接手指令

当前已批准到 Phase 5，下一阶段为 Phase 6。开始 Phase 6 前先核验交易邮件服务的运行时 Secret 名称、发送域名、webhook 验签方式和测试收件人限制，但不要读取或输出 Secret 值。Phase 6 未验收并获得明确批准前，不得开始 Phase 7。
