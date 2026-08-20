# Changelog

All notable public changes to BEYOND are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and public versions use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.0] - 2026-08-20

### Changed

- Keep each formal result in the native Worker task final and send one native wakeup that the platform handles after the current PM answer boundary.
- Let any Worker callback trigger one sweep of every registered Worker, so concurrent or coalesced callbacks are accepted without losing results.
- Keep deterministic project identity and workbench transactions while removing result-body duplication from the control runtime.

### Removed

- Remove the experimental terminal receipt store, task envelope, notify dispatcher, host adapter, CLI resume provider, WindowsApps CLI mirror, and new-task result inbox path.

### Fixed

- Preserve a busy PM answer completely, then deliver completed Worker results in a separate turn without requiring another user message.
- Make concurrent Worker completion idempotent: each final is accepted and archived once even when several notifications arrive together.
- Migrate an existing 3.1 Markdown workbench into the 3.2 machine state during project-entry fusion: keep active and paused tasks, remove completed rows from the hot view without duplicating legacy history, and preserve an exact pre-migration backup.
- Respect an existing project declaration that the control-local workbench is authoritative and a root-level legacy workbench is historical, so stale legacy tasks are not reactivated during upgrade.

## [3.1.7] - 2026-08-16

### Changed

- Use the formal Worker final and platform task state as terminal truth. An idle source PM may receive one compact reminder; a busy or unknown PM is never interrupted, and the next user turn recovers results through one zero-duration platform snapshot.
- Keep ordinary task packets short, classify Worker models by the task's primary work instead of risk words, and treat normal default business behavior as already covered rather than a new approval stop.
- Require a Codex restart and new-process verification after replacing the project entry or Skills; ordinary project-document edits remain restart-free.

### Removed

- Stop creating new result-inbox records for formal tasks. Legacy pending records are deleted only after PM verification and workbench update instead of being retained as low-value long-term history.

### Fixed

- Prevent terminal delivery from interrupting and replacing a PM answer already being generated.
- Preserve a recoverable path when the direct reminder is skipped or missed, without background polling or duplicate Worker creation.

## [3.1.6] - 2026-08-15

### Added

- Add a recoverable project-initialization state in the project overview with fixed `show`, `choose`, `record`, and `complete` actions.
- Add a deterministic two-path legacy-project regression that covers full initialization and on-demand completion without touching a real business project.

### Changed

- Make minimum adoption return one explicit user choice: complete initialization now or start ordinary work and fill remaining document groups on demand.
- Let the PM migrate or register project Markdown only during user-approved initialization, while keeping business code, tests, configuration, environments, data, and release operations outside that exception.

### Fixed

- Reject initialization entries that do not exist or are not carried by the project fact index, and revalidate every entry plus the slim root `AGENTS.md` before recording completion.
- Allow a PM to take over after verified minimum adoption when the user selected on-demand completion, instead of contradicting that path by requiring full initialization first.

## [3.1.5] - 2026-08-14

### Added

- Add a project-scoped local result inbox with fixed `enqueue`, `list`, and `ack` actions so Worker completion or pause results can be consumed by the PM at a safe user turn without interrupting an answer already being generated.
- Add a fixed Worker-policy owner with explicit `show`, `set`, and `resolve` actions. Projects can retain platform defaults or opt into the BEYOND Worker matrix: Terra/high for ordinary engineering, Luna/high for bulk structured work, and Sol/xhigh for complex or high-risk work.
- Add a real isolated control-plane integration that runs PM dispatch, Worker implementation/testing/local commit/result registration, PM verification/workbench closeout, and inbox archival as one 29-assertion chain.

### Changed

- Move persistent new-Worker policy out of root project overrides and into a managed project-overview block; initialization shows concrete choices and keeps platform defaults when the user does not choose.
- Replace direct Worker-to-PM terminal injection with one idempotent local inbox record. The PM reads it once at a user-initiated safe boundary, verifies the formal Worker and main evidence, updates the workbench, then archives the record.
- Add a fixed short workbench progress writer with validation and recoverable local backups; compact terminal summaries preserve the actual-versus-expected direction for field mappings and object ownership.

### Removed

- Remove the obsolete direct-callback integration harness so the public test suite no longer treats the retired PM-interruption path as current evidence.

## [3.1.4] - 2026-08-12

### Fixed

- Correct the Chinese and English Quick Start so installing Skills does not imply a mandatory Codex restart; restart is only needed when the current client demonstrably retains stale Skill content.
- Remove the obsolete project-level identity-guard statement from the English Quick Start while preserving unrelated third-party Hooks during legacy migration.

## [3.1.3] - 2026-08-12

### Changed

- Remove the BEYOND identity Hook from the default installation, initialization, PM takeover, and verification path. PM and Worker identity now follows the explicit Skill entry, the current user-visible task, and its source relationship.
- Keep existing-project migration precise: back up the affected files, remove only legacy BEYOND guard handlers and runtime state, and preserve unrelated project Hooks and `.codex` content.

### Fixed

- Prevent Hook trust, runtime probes, desktop tool-name normalization, and mandatory restarts from blocking installation or PM-to-Worker dispatch.

## [3.1.2] - 2026-08-12

### Fixed

- Restore `beyond-control/` under the current project root as the default installation layout; keep an external shared control repository as an explicit user choice.
- Exclude the project-local control repository from project discovery and exclude both it and local BEYOND backups from the business repository's Git index, including Windows short-path/long-path normalization.
- Keep project Hook commands and installation verification identical for project-local and explicitly external control repositories.

## [3.1.1] - 2026-08-11

### Fixed

- Require a real `PreToolUse` runtime probe for full installation verification instead of treating copied Hook files as proof that Codex trusted and executed them.
- Replace the ambiguous Desktop “Hook entry” instruction with the official Codex CLI `/hooks` trust path and a read-only compatibility diagnosis.
- Prioritize formal documents when inspecting existing projects, exclude generated/temp trees, detect nested Git repositories and duplicate remotes, and prevent active legacy workbenches from being replaced by an empty mainline.
- Migrate active legacy tasks into the local workbench and compact completed legacy tasks into history only after explicit adoption confirmation.
- Preserve existing project entry and Hook files with byte-exact backups before fusion.

## [3.1.0] - 2026-08-11

### Added

- Add an optional sibling `beyond-control` repository that keeps BEYOND documents, project-level documents, team tasks, and collaboration records together while business code stays in its existing repositories.
- Add a fixed-action Node.js script for control-repository initialization, project inspection and registration, full project-entry fusion with backup, local-workbench backup/restore, shared-record summaries, precise synchronization, and compact archives.
- Add explicit new-project and existing-project/upgrade prompts so installation no longer pretends that project adoption has already completed.
- Add a project-level Codex Hook that persists PM/Worker identity across continuation, resume, and compaction, and mechanically blocks PM business writes while preserving user-visible task controls.

### Changed

- Keep each member's PM workbench under Git-ignored `local/`, while shared team tasks and collaboration use Markdown under `shared/`.
- Preserve the v3.0.9 PM/Worker, three-state, user-visible Worker, same-Worker Action Skill, Git, test, release, and rollback paths for ordinary personal tasks.

### Fixed

- Verify the six installed Skills, control-repository structure, and the full fused project runtime kernel instead of accepting a weak pointer or a partial project entry.
- Merge rather than replace existing project Hooks, bind the identity guard to the control repository independently of the root `AGENTS.md`, and verify both installed runtime files.
- Limit ordinary PM Git writes to the current team-task or collaboration files and reject business code, project documents, repository configuration, permissions, and release files.

## [3.0.9] - 2026-08-08

See the [v3.0.8 → v3.0.9 upgrade guide](docs/en/releases/v3.0.9.md), or read the [Chinese version](docs/releases/v3.0.9.md).

### Changed

- Give PM one deterministic path for creating a fresh, project-bound, user-visible Worker task; exact project path and host identity must resolve before dispatch, and missing or duplicate registrations fail closed.
- End the PM dispatch turn after one zero-time snapshot instead of waiting for or relaying ordinary Worker progress; the Worker sends one terminal result to the injected direct source before its own final response.
- Select models for new Workers by work type before size: Terra/high for ordinary code work, Luna/high for large low-risk non-code review, and Sol/xhigh for complex architecture, debugging, or production risk when the project has adopted that matrix.
- Keep tool-process communication in the root entry so PM and Worker do not duplicate message-frequency rules.

### Fixed

- Prevent forks, projectless tasks, internal helpers, worktrees, queued client identifiers, title failures, or a second routing method from becoming fallback formal-Worker paths.
- Expand isolated and real-project regression checks for direct terminal return, project identity, user-path acceptance, scope control, Git coordination, model routing, and platform wording variation.

## [3.0.8] - 2026-08-05

See the [v3.0.7 → v3.0.8 upgrade guide](docs/en/releases/v3.0.8.md), or read the [Chinese version](docs/releases/v3.0.8.md).

### Changed

- Scope Luna/Terra/Sol routing to newly created Worker tasks; it no longer changes the current PM model, and ambiguous project overrides without a PM/Worker role do not become global model policy.
- Make project takeover restore the control plane only; old business tasks start or resume only when the same user instruction explicitly asks for that action.

### Fixed

- Add an executable installation verifier that compares all six installed Skills file by file and verifies the versioned managed portion of the project `AGENTS.md`, preventing v3.0.6/v3.0.7 hybrid installations from being reported as complete.
- Isolate project-specific `AGENTS.md` overrides in a bounded block and require role-scoped model overrides, while keeping the managed entry eligible for project version control and provenance.


## [3.0.7] - 2026-08-05

See the [v3.0.6 → v3.0.7 upgrade guide](docs/en/releases/v3.0.7.md), or read the [Chinese version](docs/releases/v3.0.7.md).

### Changed

- Start formal tasks with the Worker identity only; the Worker now selects and loads the current Action Skill so PM dispatch no longer turns design, development, testing, or operations into separate task types.
- Keep automatic continuation inside the user-authorized business result, allow approved independent results to run concurrently, and stop at a proposed new result until the user approves it.
- Create formal Workers only as fresh, user-visible tasks bound to the formal project; inherited PM history is no longer treated as Worker identity, authorization, or task ownership.
- Bind production completion to the complete candidate, database/configuration/runtime dependencies, and the real changed business path instead of health-only evidence.
- Select Luna/Terra/Sol and reasoning effort from the nature of the work when a project has explicitly adopted that model policy; otherwise retain the platform default model.
- Re-evaluate the minimum complete path when reuse or repeated candidate versions begin expanding a bounded repair into a general product mechanism.

### Fixed

- Prevent a request to stop recognition, a service, a release, or another runtime object from pausing the entire development task.
- Prevent PM evidence checks from becoming a second operational control loop that polls processes, CPU, health endpoints, business code, or task-internal tests.
- Prevent forks, projectless tasks, and copied credentials from becoming fallback dispatch paths when the formal project entry is temporarily unavailable.
- Prevent “continue, do not stop” from creating persistent automation, and keep internal context-recovery or per-command narration out of user-visible progress.
- Prevent unrelated green tests and repository-wide hook failures from being used to misstate the current task or formal delivery verdict.
- Prevent a bounded, authorized historical-data repair from being forced through an unnecessary generic-system expansion when a transactional, auditable, reversible one-off path is sufficient.

## [3.0.6] - 2026-08-04

See the [v3.0.5 → v3.0.6 upgrade guide](docs/en/releases/v3.0.6.md), or read the [Chinese version](docs/releases/v3.0.6.md).

### Changed

- Define BEYOND as a composition of identity/Action Skills, project Markdown facts, the current task, and first-hand runtime evidence rather than a pure-Skill system.
- Add a one-time existing-project compatibility check for active nested `AGENTS.md` files, subproject entries, fact indexes, and direct links without adding that scan to ordinary tasks.
- During that one-time check, reconcile conflicting current host, SSH-alias, and credential-source entries without scanning unrelated history.
- Keep PM task packets as compact business contracts instead of Worker execution manuals, and treat an explicit request to assign a team result as sufficient dispatch intent.
- Keep one formal Worker in control across design, development, testing, ordinary repair, local commits, and compact PM callback; Action Skills remain professional methods rather than new agents.
- Record canonical SSH aliases, verified host identity, recent resolved addresses, and credential sources separately so stale IPs do not become the permanent connection entry again.
- Keep user-facing status and delivery answers in business language while leaving commands, hashes, field names, and detailed evidence in their formal evidence owner.

### Fixed

- Prevent project overviews and fact indexes from becoming a second copy of generic Skill methods or from retaining obsolete workbench-activation and fixed-stage gates after an upgrade.
- Prevent the PM workbench from copying Worker route/test/batch details or retaining completed tasks after their stable result no longer affects the mainline.
- Prevent design checkpoints from creating a second implementation Worker, and prevent unconfirmed PM discussions from becoming cross-task control instructions.
- Prevent a hotfix from using a source line unrelated to the deployed target, and require shared-contract changes to close over direct consumers, adjacent checks, and the complete task-owned delivery set.
- Prevent simple PM actions from narrating every read, edit, and verification step; short tasks now keep only an opening notice and the final delivery, with status updates reserved for longer work.
- Prevent an explicitly selected Skill from being executed only from its name or description; its main instructions must be loaded, and references remain conditional on the Skill's own reading matrix.
- Prevent SSH conflicts from causing repeated password requests before the canonical alias and existing key or credential entry have been checked.

## [3.0.5] - 2026-08-03

See the [v3.0.4 → v3.0.5 upgrade guide](docs/en/releases/v3.0.5.md), or read the [Chinese version](docs/releases/v3.0.5.md).

### Changed

- Remove prescriptive pre-design, fixed test-order, automatic independent-review, helper-per-step, and worktree-creation paths from the runtime contract while retaining result-based engineering, test, Git, and release evidence.
- Treat existing worktrees as ordinary Git scenes only; BEYOND no longer creates or recommends them.
- Establish one reusable production context per release task and refresh only changed targets, artifacts, versions, authorization, verification, or rollback facts instead of reopening the same gate at every step.
- Allow a Worker to use task-local subagents for bounded investigation, testing, or cross-module checks that can run in parallel, without turning them into formal Workers or PM approval points.

### Fixed

- Allow Workers with non-overlapping owned paths and isolated side effects to edit and validate in one formal project, while serializing shared-object and Git index/HEAD/history operations.
- Keep read-only checks and ordinary progress out of new formal tasks and PM relay traffic, refresh the workbench at control-changing nodes, and require Workers to consult existing facts and runbooks before pausing for environment details.

## [3.0.4] - 2026-08-01

See the [v3.0.3 → v3.0.4 upgrade guide](docs/en/releases/v3.0.4.md), or read the [Chinese version](docs/releases/v3.0.4.md).

### Changed

- Simplify the managed task model to PM, one Worker per business result, three business states, and continuous design/development/testing/operations actions inside the same Worker task.
- Make the user-selected formal project the default workspace; worktrees are no longer created automatically, and independent clones coordinate through Git.
- Reduce default document reads, PM callbacks, task fields, and project-fact initialization while preserving reusable technology-stack, test, server, deployment, rollback, and credential-entry facts.

### Fixed

- Keep direct Action Skill requests in the current base agent, return formal Action Skill results to the original Worker, and prevent Skills from becoming additional task identities.
- Map formal Workers to user-visible top-level task threads with an explicit `$identity-worker` invocation, while keeping internal subagents as task-local helpers that never invoke the Worker identity.
- Keep each formal Worker returning to its direct PM, without propagating an ancestor source thread into the Worker task and causing bypass or duplicate delivery.
- Keep ordinary failures, local commits, authorized remote operations, and method switches inside the current Worker instead of turning them into PM approval pauses.
- Align the English architecture summary, isolated acceptance tooling, and current validation counts with the rebuilt three-state runtime path.

## [3.0.3] - 2026-07-30

Version 3.0.2 was never tagged or published from the main branch. Its release branch was abandoned; 3.0.3 continues from 3.0.1 with an independently rebuilt and tested candidate.

See the full [v3.0.1 → v3.0.3 upgrade guide](docs/en/releases/v3.0.3.md), or read the [Chinese version](docs/releases/v3.0.3.md).

### Changed

- Rebuild the real startup chain from the root entry through PM and worker identities to design, development, testing, and operations methods.
- Keep Action Skills as methods selected by the current worker or direct caller instead of allowing them to become task-control identities.
- Make the multi-agent protocol conditional on actual shared work, while one worker can move through design, development, testing, and operations without repeated PM routing.
- Tighten task-document ownership, active-document identity, cross-task handoff, and history recovery so long-running records do not grow without bounds.
- Simplify design and development delivery while preserving formal complex-design documents, engineering baselines, acceptance paths, and archive locations.

### Fixed

- Prevent PM follow-up requests such as “start development” from loading an Action Skill or executing implementation, build, test, or environment work.
- Separate terminal delivery, PM consumption, and final adjudication; preserve one terminal signal per task version and execution round.
- Stop equivalent command, runtime, test, or write retries after a platform policy rejection.
- Block direct writes when the active-task ownership check is unavailable or cannot exclude overlap.
- Make release prechecks consume existing candidate, test, environment, runtime, and rollback evidence instead of manufacturing missing evidence by rerunning tests.
- Remove internal-only regression drivers that depended on untracked task evidence; the self-contained public guards remain in `scripts/`.

### Validation

- Complete five fresh isolated runtime passes without installing into the user's active Skills directory; preserve each failed pass and rerun the full 18-scenario matrix after every repair.
- Pass the final 18-scenario identity, routing, handoff, write-isolation, testing, operations, long-observation, and terminal-consumption review.
- Pass 16/16 source-regression commands across 70 source files with zero source drift, plus the zero-dependency Node.js fixture.

### Known limitations

- User-local Skill installation, upgrade, rollback, and automatic discovery still require a separate real-environment acceptance step.
- The validation does not claim production deployment, real-server availability, or universal behavior across every Codex platform.
- The project still needs an additional maintainer who can independently review Pull Requests.

## [3.0.1] - 2026-07-21

### Changed

- Separate business authorization from Codex runtime permissions; standard tool calls now come first, and one capability can request the smallest additional permission at most once after an actual sandbox or ACL denial.
- Require design and worker reports to distinguish the current user-visible state from an unpublished proposal or candidate.
- Add static regression guards for permission handling and current-state wording to the public validation script.
- Require at least three independent, varied fresh baselines before closing an explicitly intermittent Skill-behavior report as “not reproduced.”

### Fixed

- Align the active construction task, durable behavior-test evidence, and the previously authorized PM, worker, and design candidate changes.
- Correct public documentation that still described the already-created GitHub repository, ruleset, private vulnerability reporting, and first Release as future work.

### Planned

- Verify installation, upgrade, and rollback on the supported public platforms.
- Complete the full Codex Quick Start from a fresh clone of the published remote.
- Add at least one additional maintainer who can independently review Pull Requests.

## [3.0.0-preview.1] - 2026-07-18

This is the first public preview of BEYOND 3.0.

### Added

- A document-driven operating model for AI engineering projects.
- Separate PM and worker identities with one task-control instance per business result.
- Design, development, testing, and operations as composable actions inside one task lifecycle.
- Formal project documents for objectives, task contracts, project facts, evidence, and history.
- Growing engineering, design, testing, operations, and security capability baselines.
- Explicit file, Git, service, data, environment, and production authorization boundaries.
- Multi-task event isolation using task identity, version, execution round, event identity, and actual source.
- A complete safety core with lower-frequency branches moved to on-demand Skill references.
- A zero-dependency Node.js quick-start fixture and public validation workflow.
- Apache License 2.0, contribution rules, security policy, Issue forms, and Pull Request template.
- Contributor Covenant-based community standards, a public governance contact, creator identity, and a GitHub social preview asset.
- Chinese and English product entry points, quick starts, and architecture overviews.

### Known limitations

- The six Skills and full project-template documentation are Chinese-first.
- Cross-platform installation, upgrade, and rollback evidence is not complete.
- GitHub server-side governance cannot be verified before the remote repository exists.
