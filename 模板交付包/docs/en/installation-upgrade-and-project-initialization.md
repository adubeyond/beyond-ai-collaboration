# BEYOND v3.1.2 Installation, Upgrade, and Project Initialization

> This is an operator guide, not a new runtime-rule owner. If anything conflicts, follow the project-root `AGENTS.md`, the identity Skills, and the actual result of the fixed scripts.

## 1. Four separate milestones

| Milestone | Completion evidence |
| --- | --- |
| Install or upgrade files | `beyond-control/beyond-release.json`, all six installed Skills, and the project entry report `3.1.2` |
| Review and trust the Hook | `/hooks`, opened from Codex CLI at the project root, shows the current project Hook enabled and trusted |
| Verify installation | The real Hook probe succeeds and the integrity verifier exits `0` |
| Initialize the project | Project boundaries, the workbench, legacy tasks, and durable fact locations have been investigated and confirmed by the user |

The complete order is:

```text
prepare the v3.1.2 package and six Skills
→ initialize or upgrade the project entry
→ review and trust the Hook
→ run the real probe and integrity verifier
→ restart Codex
→ confirm project initialization
→ start a new PM for the main line
```

Do not maintain BEYOND from an existing PM or Worker conversation. Use a new ordinary conversation without an identity Skill so an old PM guard is not responsible for replacing itself.

## 2. Prepare v3.1.2

Obtain the immutable [v3.1.2 release](https://github.com/adubeyond/beyond-ai-collaboration/releases/tag/v3.1.2). Put the complete `模板交付包` under the business-project root as `beyond-control`; do not scatter package files over the project.

Install these six directories from `beyond-control/skills/` into the active Codex Skills directory:

```text
identity-pm
identity-worker
task-design
task-dev
task-test
task-ops
```

During an upgrade, preserve the existing control repository's `local/`, project records, project facts, and `shared/` collaboration content. Never replace real project data with empty templates. Regardless of the copy method, finish with the integrity verification in section 6.

Prompt for an AI-assisted maintenance conversation:

```text
This is BEYOND installation maintenance. Do not create a PM, Worker, or business task.
Install or upgrade the current project's beyond-control directory and six global Skills from the official v3.1.2 release.
Back up the current entry, Hook, and local control data first. Preserve native project rules and real content under local, projects, and shared; do not overwrite them with empty templates.
Afterward, report only file versions and the remaining Hook-trust step. Do not claim project initialization is complete.
```

## 3. Initialize a new project

After installing the Skills and restarting Codex, open a new conversation at the project root:

```text
$identity-pm
Use BEYOND to initialize this new project.
```

The PM investigates first and asks one currently necessary question at a time. When the PM presents the fusion boundary, confirm:

```text
Confirm BEYOND-led AGENTS.md fusion while preserving the project's native rules. Establish only the project entry and document foundation; do not start business tasks or push remote Git.
```

Then complete Hook trust and verification in sections 5 and 6.

## 4. Adopt or upgrade an existing project

Open a new conversation at the existing project root:

```text
$identity-pm
Use BEYOND to adopt or upgrade this existing project.

First inspect the existing AGENTS.md, code and Git boundaries, Markdown documents, legacy workbench, and tasks that may still be running.
Do not reinstall, start, or resume business tasks. Ask me to confirm one migration or fusion decision at a time.
```

Confirm project and repository boundaries, truly active tasks, legacy-workbench migration, durable product/engineering/test/operations fact locations, entry/Hook fusion, and local/team identity. Use this confirmation when ready:

```text
Confirm BEYOND-led AGENTS.md fusion while preserving all native project rules and formal documents.
Back up the legacy workbench, move only truly active tasks into the current workbench, and move completed or obsolete items into history without deleting their conversations or evidence.
Complete existing-project initialization only; do not start or resume business tasks or push remote Git.
```

Before initialization is complete, the PM must show the current main line, active tasks, backlog/history, fact locations, and remaining unknowns for user confirmation. Automatically generated minimum-adoption documents are candidates, not a replacement for this review.

## 5. Review and trust the Hook

After entry fusion, start Codex CLI from the business-project root:

```powershell
cd <business-project-root>
codex
```

Enter:

```text
/hooks
```

Confirm the source is the current project's `.codex/hooks.json`, then trust it and keep it enabled. Project trust and Hook-definition trust are separate. Review is required once after first installation or whenever the Hook content changes; it is not a per-task approval.

If an old PM blocks maintenance, stop retrying there. Use the ordinary maintenance conversation from section 2, then review the new Hook from the project-root CLI. Do not leave the guard disabled.

## 6. Run the real probe and integrity verifier

After trust, run this prompt in a new Codex task at the project root:

```text
Run only this fixed command and report its exit code; do nothing else:
node beyond-control/scripts/beyond-control.mjs hook-probe --project-root "."
```

It must report `runtimeProbePassed: true`. Then run:

```powershell
node beyond-control/scripts/verify-install-integrity.mjs --installed-skills-root "<Codex Skills directory>" --project-agents "<business-project-root>/AGENTS.md"
```

Installation is verified only when this exits `0` and confirms that the six Skills, control repository, project runtime kernel, and real Hook probe match. `--content-only` proves file equality, not Hook execution.

If files report 3.1.2 but no probe exists, inspect `/hooks` and the project root. If trusted Hooks still show old behavior, fully restart Codex and use a new conversation. If the CLI has no `/hooks`, record `codex --version` and `codex features list` as a compatibility gap.

## 7. Restart and let a new PM take over

After installation verification and project-initialization confirmation, fully restart Codex Desktop. Do not continue the installer or an old PM conversation. Start a new PM at the project root:

```text
$identity-pm
Take over the current project. BEYOND v3.1.2 installation, Hook verification, and project initialization are complete.
Read the current workbench and report only the main line, active tasks, paused tasks, and next action. Do not recreate, start, or resume tasks yet.
```

After confirming the list:

```text
Resume the original tasks that are still in progress. Keep paused tasks paused, and do not restart completed tasks.
```
