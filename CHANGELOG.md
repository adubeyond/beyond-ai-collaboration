# Changelog

All notable public changes to BEYOND are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and public versions use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.2] - 2026-07-24

### Added

- Add a zero-dependency project-template manager with explicit targets, dry-run, per-file hashes, conflict detection, backup manifests, failure recovery, version inspection, verification, upgrade, and rollback.
- Add deterministic public CI for identity, permission, platform, encoding, and behavior-probe contracts without representing static checks as model-behavior validation.
- Add a bilingual Windows + Codex Desktop support boundary and a reproducible natural-language control probe plan.
- Gate the version-sensitive contract, installer, promotion, and minimal-example suites on `windows-latest` with Node.js 24 while retaining the existing aggregate `validate` check.

### Changed

- Keep PM and worker identities stable across action words, define explicit handoff and post-terminal release behavior, and preserve direct execution when no management identity exists.
- Separate business authorization, approval policy, legacy sandbox settings, permission profiles, filesystem scope, and network scope; `default_permissions` alone is no longer presented as proof of prompt-free Full Access.
- Enforce LF for public text through `.gitattributes` and raw-byte installation manifests; version the construction candidate as `3.0.2-rc.3` without promoting or publishing it.
- Bind task work to the named canonical project root, require explicit `local` or `worktree` selection, register directory lifecycles, bound directory diagnostics, and report truthful worktree/Git convergence at closeout.
- Bound default reads, compact both low-risk and complex task packages without dropping authorization, rollback, or red-light fields, suppress no-decision progress chatter, and keep normal final replies result-first.
- Restrict launch backpressure to desktop `create/resume/wake` orchestration: workers cannot recurse, probe groups reuse one leaf, streaming targets are never batch-woken, and healthy isolated business tasks remain eligible for bounded parallelism.

### Fixed

- Make the auto-loaded root `AGENTS.md` managed registry block the single active-PM conflict source, and update acquisition, explicit replacement, and release with revision-checked atomic block replacement.
- Move registered-PM conflict detection ahead of project initialization, README, workbench, and Git reads: consult one explicit lightweight PM registration, stop without further tools when it conflicts, and return a redacted choice-only result that does not expose mainline, branch, commit, or thread identifiers.
- Keep projectless PM takeover from treating an explicitly loaded rules-source directory as the business project; return a concise receipt or one minimum unlock question without expanding into the control plane, while preserving safe reads for named real projects.
- Make `identity-pm` the sole operational owner of the registered-PM conflict fast path: after a real-project safe read finds the same project and mainline still controlled, perform one targeted status check and immediately return the conflict result with at most one necessary progress update; the root entry only routes and does not duplicate the procedure.
- Use one identical PM/worker terminal-identity contract across the project entry and PM Skill: managed task completion does not release the PM, while worker authority ends with that task's terminal write-back.
- Build and verify backups in a uniquely owned pending directory, then atomically publish them so interrupted backup construction leaves no selectable partial backup.
- Keep plans, prompts, automatic titles, and platform streaming/idle/completed observations out of business progress and terminal truth; only consumed lifecycle events with readable evidence can close the control plane.

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
