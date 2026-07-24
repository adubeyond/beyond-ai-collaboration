# Install, permissions, and platform support

**English** | [简体中文](../安装、权限与平台支持.md)

> Core boundary: reading `AGENTS.md`, loading a Skill, or starting an internal subagent does not prove that a Codex surface can run BEYOND's complete formal-task collaboration. Complete mode also requires the PM to create a user-visible task, send a follow-up to that task, read its result, and let the user enter the task directly to correct it.

This page is the single public product source for the installation chain, Codex runtime permissions, and platform capabilities. A project task contract still owns business authorization; Skills execute this contract without inventing platform capabilities.

## Zero-dependency project-template manager

The only formally supported and accepted combination for this version is Windows + Codex Desktop, with Node.js 24.x as the current tested script-runtime baseline. The manager installs only `AGENTS.md`, `docs/AI编程协同机制/`, and `skills/` from the template package into an explicit project directory. It never installs into a real Codex runtime directory and does not overwrite the target project's README.

Run from the selected BEYOND source root:

```text
node scripts/beyond-install.mjs install --target <absolute-project-path> --dry-run
node scripts/beyond-install.mjs install --target <absolute-project-path>
node scripts/beyond-install.mjs version --target <absolute-project-path>
node scripts/beyond-install.mjs verify --target <absolute-project-path>
```

Upgrade from the new BEYOND source only after verifying the managed tree:

```text
node <new-source>/scripts/beyond-install.mjs verify --target <absolute-project-path>
node <new-source>/scripts/beyond-install.mjs upgrade --target <absolute-project-path> --dry-run
node <new-source>/scripts/beyond-install.mjs upgrade --target <absolute-project-path>
```

A successful upgrade prints a backup ID. Rollback verifies the current tree before restoring that backup:

```text
node <current-source>/scripts/beyond-install.mjs rollback --target <absolute-project-path> --backup <backup-id> --dry-run
node <current-source>/scripts/beyond-install.mjs rollback --target <absolute-project-path> --backup <backup-id>
```

Install and upgrade manifests use raw-byte per-file SHA-256 values and a tree digest. A colliding target file, managed-file drift, symbolic link, path escape, corrupt manifest, missing source, or hash mismatch stops the operation. Upgrade constructs and verifies the backup in one uniquely owned pending directory, writes the complete manifest, and only then atomically renames it on the same filesystem into the selectable backup location. Construction failure removes only that pending directory and changes neither the managed tree nor installation manifest. An injected or real mid-upgrade failure restores the old files and manifest; a rollback failure restores the pre-rollback candidate so the operation remains retryable.

Project operation normally changes workbench or project-fact files. That is managed-file drift. The manager will not merge or overwrite it automatically; review and preserve project facts before re-establishing a verifiable state.

## Permission contract

BEYOND keeps six boundaries separate:

| Boundary | Question | Source of truth |
| --- | --- | --- |
| Business authorization | Which files, Git actions, services, data, or production objects may this task change? | User and formal task contract |
| Approval policy | When does Codex pause for the user or automatic review? | Actual injected `approval_policy` for this turn |
| Sandbox | Which files and network resources can commands reach under the legacy system? | Actual `sandbox_mode` and matching settings |
| Permission profile | Which combined filesystem and network rules apply under the profile system? | Actual profile and rules |
| Filesystem boundary | Which roots are readable, writable, or denied? | Actual filesystem policy and writable roots |
| Network boundary | Is network enabled, and to which destinations? | Actual network policy and one side-effect-free probe when needed |

Actual injected values are runtime truth. Project settings, an old turn, a creation request, or a UI expectation show intent only. If a necessary capability is not exposed, use at most one side-effect-free standard probe. Tool access does not grant business authorization, and business authorization cannot widen the sandbox.

Current Codex documentation defines two sandbox configuration systems that must not be mixed:

- permission profiles use `default_permissions` and `[permissions]` for combined filesystem and network rules;
- the legacy system uses `sandbox_mode` and `[sandbox_workspace_write]`.

If any loaded config, CLI argument, or selected profile provides legacy `sandbox_mode`, Codex uses the legacy system instead of composing it with `default_permissions`. `approval_policy` separately controls approval pauses. Therefore `default_permissions` alone proves neither `approval_policy=never` nor prompt-free Full Access in a new task. In the legacy system, unsandboxed and prompt-free execution requires the current turn to actually inject both `danger-full-access` and `never`. A permission-profile run must separately verify the actual profile, approval policy, filesystem, and network result.

Official sources: [Permission modes](https://learn.chatgpt.com/docs/permission-modes), [Permission profiles](https://learn.chatgpt.com/docs/permissions), and [Configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference). Permission profiles are currently Beta, so compatibility claims must stay tied to a client version and current-run evidence.

## Codex Desktop support boundary

| Runtime combination | Current product status | Formal-task capability requirement | Boundary when a capability is missing |
| --- | --- | --- | --- |
| Windows + Codex Desktop | The only formally supported and accepted combination for this version | The current session must expose user-visible task creation, addressed follow-up messaging, task reading, and direct user correction; loading a Skill proves none of them | Do not claim complete PM-to-worker mode; use one task or a user-created/manual handoff only within the current authorization |
| Codex CLI, IDE, cloud, Linux (including Ubuntu), macOS, or any other client | Uncommitted and unverified; outside this version's support scope | Reading `AGENTS.md`, loading Skills, or showing subagents does not prove the formal-task contract | Do not fabricate a formal lifecycle; future compatibility requires a separate task and is not a `PROMOTION_GATE` blocker for this version |

Product version, account, administrator policy, and tools exposed in the current session can narrow Windows + Codex Desktop capabilities; evidence from one surface does not transfer to another. The standard-library scripts may run elsewhere, but code portability is not product-support or validation evidence.

## Natural-language control regression

Public CI runs on `windows-latest` with Node.js 24:

```text
node scripts/check-control-contracts.mjs
```

This deterministically checks cross-file ownership, dependent entry points, permission-system separation, Quick Start warnings, installation entries, encoding policy, and CI wiring. It explicitly reports `behavior=NOT_RUN`; string presence is not model-behavior GREEN, and CI cannot replace real Codex Desktop behavior validation.

Print the reproducible real-behavior probe plan with:

```text
node scripts/check-control-contracts.mjs --list-behavior-probes
```

The plan covers the exact two-turn incident, PM action synonyms, direct execution without a PM, explicit PM-to-worker handoff, post-terminal release and the next task, combined actions, ambiguous instructions, and user-visible task titles. The title case also retains the machine Skill IDs in the child's initial prompt, the `create_thread → set_thread_title` order, the final concise Chinese title, and adjacent evidence that title failure does not block the created business task; the PM must not open, read, or wait for the child merely to set its title. Send each case verbatim in an independent fresh Codex task. Retain the surface, client version, Skill-tree hash, raw output, task locator, and human verdict. Only real tasks using the same frozen candidate can close the behavior release gate.

## Line endings, encoding, and platform evidence

- Public text is UTF-8 without BOM and LF. Root `.gitattributes` fixes Markdown, JavaScript, JSON, YAML, and PowerShell text to `eol=lf`; PNG is binary.
- Git blobs, installation sources, manifests, and runtime copies are hashed as raw bytes. No CRLF/LF normalization is used for identity; an unregistered line-ending change is drift.
- Windows checkouts must honor `.gitattributes`; manual copying should preserve bytes. If an editor converts a file to CRLF or adds a BOM, `verify` must fail instead of treating it as the same candidate.
- The candidate manager and tests use only Node.js standard-library APIs. Native Windows/Node.js 24 tests are current first-hand evidence. Public CI repeats the control contracts, installer transactions, promotion checker, and minimal example on `windows-latest` with Node.js 24, but it still validates scripts only and cannot replace real Codex Desktop behavior. CLI, Linux (including Ubuntu), macOS, IDE, and cloud surfaces are uncommitted and unverified; they are not release blockers for this version, and code that happens to run there is not a support claim.
- Project-template installation and Codex runtime Skill installation are separate chains. This manager does not write runtime copies; use the supported path for the active Codex surface to install, select, and reload runtime Skills.

This construction candidate is not promoted, published, or installed into any runtime environment.
