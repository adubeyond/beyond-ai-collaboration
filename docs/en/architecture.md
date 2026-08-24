# BEYOND 3.2 Architecture Overview

**English** | [简体中文完整版](../系统架构与运行机制.md)

BEYOND turns Codex into a PM-led agent team. Its purpose is to complete real business work quickly and accurately while keeping production, data, and irreversible actions safe.

## Core roles

| Component | Responsibility |
| --- | --- |
| User | Business direction, major trade-offs, and high-risk authorization |
| PM | Mainline, task allocation, workbench, shared conflicts, and acceptance |
| Worker | One business result from investigation through delivery |
| Action Skills | Professional design, development, testing, and operations methods |
| Control-repository documents | Stable goals, reusable project facts, optional shared team records, and each member's Git-ignored local PM view |
| Git and tools | File versions, execution, and first-hand reality |

PM and Worker are agent identities. Design, development, testing, and operations are methods, not additional agents.

Version 3.2 preserves the short ordinary-task path and the project-local `beyond-control/` repository. It adds deterministic project identity, transactional workbench convergence, and one short-lived terminal receipt that closes a host gap in resumed Worker turns without adding a Hook, notifier adapter, daemon, or extra Codex CLI.

## Default task flow

```text
user result
→ PM records one task and assigns one Worker
→ Worker reads only relevant project facts
→ Worker designs, implements, tests, repairs, and delivers continuously
→ Worker freezes one final, stores the same text as pending, wakes PM once, and outputs the final
→ PM verifies evidence, updates the workbench, and deletes the consumed pending receipt
```

A normal task package contains only:

```text
projectId + taskId
business result
scope and explicit non-goals
acceptance criteria
formal project, target, and delivery method
relevant project-fact entries
real pause boundaries
```

The packet is a compact business contract, not a PM-authored execution manual. A formal task is fresh, user-visible, and bound to the formal project; a fork that inherits PM history, a projectless task, or an internal helper cannot carry a formal business result. The task explicitly starts only the Worker identity. Before the one native callback, the Worker stores the exact frozen final as project-local pending state. This is a short-lived control snapshot, not a second business result or message archive; PM deletes it only after the matching workbench transaction succeeds. The Worker then selects and loads one Action Skill for the current primary problem and may switch methods later without creating stage-specific tasks.

Test verdicts preserve the full coverage denominator, including failures, skips, and exclusions. Offline evidence does not impersonate current DOM, GUI, network, database, or runtime canaries, and a task-scoped candidate verdict does not turn a failing repository-wide gate green. Testing by the same Worker is professional testing, not independent testing.

A hotfix binds to the source identity of its formal target. If the current branch is not a descendant of that target, or if the range contains unrelated changes, the Worker prepares the change on the target baseline instead of presenting a next-release package as deployable. Shared modules and external contracts use current samples or schemas and close over direct consumers, adjacent behavior, and the complete task-owned commit.

## Workbench and project facts

Each member's PM workbench is a local dashboard under the control repository's Git-ignored `local/`. It records the task, responsible Worker/thread, one of three states, one current business milestone, blocking risk, one formal result or evidence entry, and update time. Shared team tasks and collaboration are separate Markdown records under `shared/`; neither side is a full mirror of the other.

Project facts preserve reusable knowledge such as the technology stack, build and test commands, module boundaries, servers, services, logs, deployment steps, and rollback paths. Missing facts do not block unrelated work. A Worker investigates and writes reusable facts in the same business task when needed.

A production task establishes one current context for its target, running version, source and complete artifact, database/configuration/runtime dependencies, allowed effects, health and business checks, rollback, and authorization. After that context is closed, preflight, release, verification, and pre-authorized rollback continue without repeated PM round trips. Only facts that actually change are refreshed. Process health, a reachable page, or HTTP 200 does not replace the real changed business path such as login, query, or write.

Project facts do not use an `uninitialized / refresh-needed / available` runtime state machine.

PM or Worker identity comes from the explicit user entry, the current user-visible task, and its source relationship; resume or compaction does not change that identity. BEYOND does not require a platform Hook for identity or installation and does not present documentation as an operating-system security boundary. Codex permissions, Git protection, server and database ACLs, project rules, and explicit user authorization remain the hard controls for high-risk actions. Existing-project upgrades remove only legacy BEYOND guard handlers and preserve unrelated Hooks.

## Three business states

- `in progress`
- `paused`
- `completed`

Design, development, testing, repair, commit, and acceptance are actions rather than additional states.

A user checkpoint such as “design first, implement after confirmation” keeps the original task in progress and resumes the same Worker after confirmation. Discussions, suggestions, and candidate proposals do not change another active task's prerequisites, pause conditions, or authorization until the user confirms them.

A task pauses only for:

1. a business choice that the user must make;
2. production, destructive data, irreversible, or significant-cost authorization;
3. a real shared conflict that cannot be handled safely;
4. an objectively unavailable account, environment, credential, target, or external resource.

## Git and workspaces

The user-selected formal project is the default workspace. BEYOND does not create or recommend worktrees.

Workers may edit and validate in the same formal project when task-owned paths and modules are explicit, shared objects do not overlap, and runtime side effects are isolated. Actual overlap in a file, contract, data object, service, environment, or generated output serializes only the affected action.

Git manages versions, commits, rollback, and integration. The PM workbench manages people and order.

- People with independent clones can collaborate through branches.
- Workers sharing one Git working directory serialize index, HEAD, and history operations and stage only task-owned paths.
- If the user or platform already provided a worktree, treat it only as the current Git scene, verify its source and formal target, and do not create another one.

## Evidence and safety

Current code, Git, tests, services, data, and production reality override old documents and chat summaries.

Read, local write, local commit, remote Git, deployment, shared/production data, irreversible actions, and external cost remain separate authorization dimensions. Safety triggers from the actual effect of an action, not from keywords such as “database,” “server,” or “Git.”

Completion requires the result to exist in the agreed formal target and current first-hand evidence to satisfy acceptance. UI and business acceptance follows the affected user operation path rather than a single endpoint or visible button. Passing tests does not mean the feature is deployed.

See the [full Chinese architecture](../系统架构与运行机制.md) and [quick start](quick-start.md).
