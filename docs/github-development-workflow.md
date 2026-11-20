# Git 与部署参考

现行规则见 [AGENTS.md](../AGENTS.md)，唯一当前进度见 [STATUS](STATUS.md)。

- Inspect → Implement → Test → Fix → Verify → Commit → Continue。
- 普通功能复用安全开发分支，Modify → Test → Commit；可直接 push，不强制 PR。
- 按需 fetch，保护已有修改；不强推、不 hard reset、不绕过分支保护或必要检查。
- main 可能触发生产发布，日常工作留在非生产开发分支；发布前核对平台触发条件和目标 SHA。
- 分级测试；成功检查仅在输入或风险变化时补跑；最终上线执行完整适用回归。
- 各 Phase 自主内部验收和继续，不需逐阶段人工批准；不将自动测试记为人工批准。
- Preview 按需部署，核实资源共享边界；生产发布须有已授权范围、回滚方案和受控测试结账。
- 高风险操作按 AGENTS 单独审批；不改变支付模式或数据保护边界。
- 重要节点更新 STATUS；跨会话确需恢复才简短交接，不并行维护 Progress。
- 历史 Phase、Handoff、验收记录仅为证据，不是当前流程指令。
