# BEYOND 3.0 Architecture Overview

**English** | [简体中文完整版](../系统架构与运行机制.md)

BEYOND turns Codex into a PM-led agent team. Its purpose is to complete real business work quickly and accurately while keeping production, data, and irreversible actions safe.

## Core roles

| Component | Responsibility |
| --- | --- |
| User | Business direction, major trade-offs, and high-risk authorization |
| PM | Mainline, task allocation, workbench, shared conflicts, and acceptance |
| Worker | One business result from investigation through delivery |
| Action Skills | Professional design, development, testing, and operations methods |
| Project documents | Stable goals, reusable facts, and the PM's current team view |
| Git and tools | File versions, execution, and first-hand reality |

PM and Worker are agent identities. Design, development, testing, and operations are methods, not additional agents.

## Default task flow

```text
user result
→ PM records one task and assigns one Worker
→ Worker reads only relevant project facts
→ Worker designs, implements, tests, repairs, and delivers continuously
→ Worker returns either completion or one real blocking reason
→ PM verifies evidence and updates the workbench
```

A normal task package contains only:

```text
business result
scope and explicit non-goals
acceptance criteria
formal project, target, and delivery method
relevant project-fact entries
real pause boundaries
```

## Workbench and project facts

The PM workbench is a team dashboard. It records the task, responsible Worker/thread, one of three states, current progress, blocking risk, formal result, and update time. It is not a Git HEAD mirror or an execution permit.

Project facts preserve reusable knowledge such as the technology stack, build and test commands, module boundaries, servers, services, logs, deployment steps, and rollback paths. Missing facts do not block unrelated work. A Worker investigates and writes reusable facts in the same business task when needed.

A production task establishes one current context for its target, running version, source and artifact, allowed effects, health and business checks, rollback, and authorization. After that context is closed, preflight, release, verification, and pre-authorized rollback continue without repeated PM round trips. Only facts that actually change are refreshed.

Project facts do not use an `uninitialized / refresh-needed / available` runtime state machine.

## Three business states

- `in progress`
- `paused`
- `completed`

Design, development, testing, repair, commit, and acceptance are actions rather than additional states.

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

Completion requires the result to exist in the agreed formal target and current first-hand evidence to satisfy acceptance. Passing tests does not mean the feature is deployed.

See the [full Chinese architecture](../系统架构与运行机制.md) and [quick start](quick-start.md).
