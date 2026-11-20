# 开发规则审计（2026-11-20）

## 实际范围与自动生效规则

- 工作区 `/Users/jklau/Desktop/CPwebsite` 不是 Git 仓库；仓库根为 `source/`。
- 检查 `/`、`/Users`、用户目录、Desktop、工作区及仓库根的 AGENTS.md / AGENTS.override.md：均无适用文件；全局 `/Users/jklau/.codex/AGENTS.md` 为空，未修改。
- 仓库内（含隐藏路径，排除 .git、node_modules、dist）未找到嵌套 AGENTS 或 override；缓存 origin/main 也无 AGENTS。全局 config.toml 未发现 instructions/model_instructions_file/project_doc 配置项。本次未修改全局设置。
- 新根 AGENTS.md 是今后仓库范围的自动发现指令入口；会话系统、开发者和用户要求仍优先。不存在需要同步精简的下级自动指令。
- README、docs 下交接/验收/协作说明、.openai/hosting.json 都不是自动加载指令。旧文档中的“必须”措辞不能据此当作自动加载行为。

## 审计发现与处理

| 发现 | 处理 |
| --- | --- |
| README 混合原型、Phase 1–3 描述，把真实账户/数据说成纯 localStorage | 改为架构、命令、环境名称、部署和索引；明确本地/缓存版本差异 |
| 旧 handoff 停在 Phase 4；未跟踪 progress 停在 Phase 5；缓存验收已到 Phase 6 | STATUS 汇总可证实状态，标注证据来源；旧 handoff 加历史说明，用户未跟踪文件逐字保留 |
| 缓存协作指南要求每次切 main/fetch/pull、重复历史、完整测试、Preview、多个进度文件 | 新建精简本地协作参考；现行根指令改为按需同步、分级验证、单一状态入口 |
| 历史 handoff 要求特定接手命令及全套阅读；progress 要求每次三套检查和 Preview | 不继承为现行日常要求；保留历史记录及正式验收门禁 |
| 技术栈被描述为 React | 当前和缓存配置/README 均为原生 JavaScript；不迁移框架 |
| 原始 Phase 1/2 标题状态落后于后续批准记录 | 原始证据不改；STATUS 依据后续验收确认，避免重写审批历史 |
| Phase 6 记录 merge SHA pending/生产未验证，但缓存已有合并提交 | 记录为证据差异；不擅自认定生产验证或 Approved Phase 6 |

未发现仓库原有“每改动新建 Handoff”“每任务完整架构审查/项目摘要”的自动规则，不虚构删除；根指令明确日后无需如此操作。历史技术、安全、恢复点及 Phase 验收证据全部保留，无文件删除、移动或大量重命名。

## CI、部署与引用

- 已读本地 package.json、checks.yml、cloudflare.config.ts、构建/语法脚本；缓存的协作指南、Phase 4–6、README、package/config 仅定向 git show。
- GitHub Actions 在 main、phase-*/** push 和所有 PR 执行 ci/test/build/runtime，无部署步骤。
- Cloudflare Builds 是独立平台自动部署来源；历史 docs 路径排除不能视为当前保证。下次获准发布前须实时核验触发条件，不为本次文档工作部署。
- 脚本、CI、hosting 配置中未发现对 handoff/progress/README/docs 的流程引用。既有文件不移动，原始验收文件零改动。
- 缓存远端比本地新；本次没有拉取业务变更。新增协作参考今后移植到最新 main 时，应审查替换远端旧指南，不能整目录覆盖或盲目合并本地历史。

## 验证边界

本次只修改 Markdown；检查 whitespace diff、相对链接、文件白名单、关键约束、原始验收未变及用户未跟踪文件 SHA-256。未运行应用测试、构建、迁移、Preview 或生产部署，不能将历史测试结果报告为本次通过。

## 后续同步（2026-11-20）

用户要求检查并同步后，已 fetch GitHub；main 仍为 `343f43a`。旧本地提交保存在 `backup/pre-workflow-sync-20261120`，全部未提交文件保存在带说明的 stash 和临时目录副本。本地 main 已对齐 origin/main，流程优化恢复在 `docs/workflow-optimization` 分支；README/STATUS 已按同步后的代码更新。远端较新的 progress 报告保留，未用旧本地报告覆盖。另发现未合入 main 的 `fix/phase6-delivery-recovery` 分支，未自动合并。以上同步不改变 Phase 批准、安全或生产限制。

同步后实际验证：`npm test` 45 项及商品编辑回归通过，`npm run build` 通过。runtime 首次因沙箱禁止监听 127.0.0.1 而失败，授权解除限制后重跑 2 项通过。相对链接与 `git diff --check` 通过；main/HEAD 与 fetch 后 origin/main SHA 一致，业务源码/迁移/部署配置无本地差异。未安装依赖、运行迁移或部署。

## 最终自主工作流迁移（2026-11-20）

本节取代上文审计时保留的旧阶段门禁。用户明确授权本次规则迁移及自主推进。

| 路径 | 原规则 / 生效方式 | 新规则 / 处理 |
| --- | --- | --- |
| AGENTS.md | 自动发现；功能必须分支/PR，逐 Phase Approved，生产须重复许可 | 已移除；安全开发分支直接提交，可 push，自主内部验收推进；发布核实回滚和授权边界 |
| README.md | 参考；重复阶段/审批说明与发布许可 | 仅架构、命令、配置名称、部署与技术索引 |
| docs/github-development-workflow.md | 被引用；任务分支/PR、人工门禁及重复公开记录许可 | 统一自主工作流和生产保护 |
| docs/STATUS.md | 当前进度引用旧停止指令 | 唯一当前状态，依据本轮证据更新 |
| docs/progress-handoff-2026-11-19.md | 旧进度包含强制阅读/阶段暂停 | 明确历史快照，不并行维护进度；原证据保留 |
| docs/handoff-2026-11-19.md、phase-*-acceptance.md | 历史流程/批准要求 | 仅历史证据，根规则明确不继承其流程指令；不删除原始证据 |
| .github/workflows/checks.yml | CI test/build/runtime；无 PR 或人工阶段执行脚本 | 保留检查；开发分支加入 push 检查范围 |

父目录与全局未发现有效 AGENTS 指令；全局文件不变。兄弟工作树 phase6-completion/AGENTS.md 不适用于 source/，不修改其他工作树。无嵌套 AGENTS/override。脚本和 CI 未引用交接/进度文件实施门禁。未关闭保护、改写历史、删除迁移或原始验收记录。

最终复核：全局 AGENTS 为空，父目录及全局 override 不存在，未修改全局指令。仓库核心规则 70 行。CI 保留应用检查，代码 push 覆盖 main、phase、dev 和既有开发分支，纯 Markdown/docs push 跳过应用 CI；PR 检查保持。GitHub main 当前无分支保护、rulesets 为空；本轮未修改任何保护设置。生产发布仅在核对目标、回滚和实际验收后执行，临时 QA 权限经用户另行明确批准并在验收后撤销。
