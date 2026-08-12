# BEYOND Installation, Upgrade, and Project Initialization

> This is an operator guide, not a second runtime-rule owner. Follow the target release package, project-root `AGENTS.md`, identity Skills, and fixed-script results if anything conflicts.

## 1. Three separate outcomes

| Outcome | Completion evidence |
| --- | --- |
| Install or upgrade files | `beyond-control/beyond-release.json`, all six installed Skills, and the project entry belong to the same target release |
| Verify installation | The verifier exits `0`, with no stale, mixed, or legacy BEYOND Hook content |
| Initialize the project | Project boundaries, the workbench, legacy tasks, and durable fact locations are investigated and confirmed by the user |

The standard order is:

```text
prepare the target package and six Skills
→ initialize or upgrade the project entry
→ run installation verification
→ confirm project initialization
→ start a new PM for the main line
```

The standard BEYOND path does not install an identity Hook and does not require `/hooks`, a runtime probe, or a restart for guard activation. Use a new ordinary conversation without an identity Skill for installation maintenance so an active PM or Worker does not replace its own project entry while doing business work.

## 2. Prepare the target release

Obtain the immutable package from the target Release. Put the complete `模板交付包` under the business-project root as `beyond-control`; do not scatter package files over the project.

Install these six directories from `beyond-control/skills/` into the active Codex Skills directory:

```text
identity-pm
identity-worker
task-design
task-dev
task-test
task-ops
```

During an upgrade, preserve real content under `local/`, `projects/`, and `shared/`. If an existing `.codex/hooks.json` references `beyond-runtime-guard.mjs`, the fixed script removes only those legacy BEYOND handlers after backup. Other Hooks and `.codex` files remain unchanged.

Prompt for an AI-assisted maintenance conversation:

```text
This is BEYOND installation maintenance. Do not create a PM, Worker, or business task.
Install or upgrade the current project's beyond-control directory and six global Skills from the target official release.
Back up the project entry and local control data. Preserve native rules and real local, projects, and shared content; never replace them with empty templates.
If a legacy BEYOND identity Hook exists, remove only BEYOND handlers and guard files while preserving all other Hooks and .codex content.
Run installation verification afterward. Do not claim project initialization or business work is complete.
```

## 3. Initialize a new project

After installing the six Skills, open a new conversation at the project root:

```text
$identity-pm
Use BEYOND to initialize this new project.
```

The PM investigates first and asks one currently necessary question at a time. Confirm entry fusion with:

```text
Confirm BEYOND-led AGENTS.md fusion while preserving the project's native rules.
Establish only the project entry and document foundation; do not start business tasks or push remote Git.
```

Then run section 5 verification.

## 4. Adopt or upgrade an existing project

Open a new conversation at the existing project root:

```text
$identity-pm
Use BEYOND to adopt or upgrade this existing project.

First inspect the existing AGENTS.md, code and Git boundaries, Markdown documents, legacy workbench, and tasks that may still be running.
Do not reinstall, start, or resume business tasks. Ask me to confirm one migration or fusion decision at a time.
```

Confirm repository boundaries, active tasks, legacy-workbench migration, durable product and engineering fact locations, entry fusion, and local/team identity. When ready:

```text
Confirm BEYOND-led AGENTS.md fusion while preserving all native project rules and formal documents.
Back up the legacy workbench, move only truly active tasks into the current workbench, and archive completed or obsolete items without deleting conversations or evidence.
Remove only legacy BEYOND identity Hook content and preserve all other Hooks.
Complete existing-project initialization only; do not start or resume business tasks or push remote Git.
```

Before initialization is complete, the PM shows the current main line, active tasks, backlog/history, fact locations, and remaining unknowns for user confirmation.

## 5. Verify installation

From the project root, run:

```powershell
node beyond-control/scripts/verify-install-integrity.mjs --installed-skills-root "<Codex Skills directory>" --project-agents "<business-project-root>/AGENTS.md"
```

Installation is verified only when it exits `0` and confirms matching Skills, control structure, and project runtime entry. It also rejects remaining legacy BEYOND guard content. `--content-only` checks candidate content only; it does not prove project fusion.

Third-party Hooks are preserved and are not BEYOND verification targets. If a legacy BEYOND guard remains, rerun the fixed existing-project fusion path instead of deleting the whole `.codex` directory.

## 6. Let a PM take over

After installation verification and project-initialization confirmation, start a new PM at the project root. A restart is not mandatory unless the current client demonstrably retains stale Skill content.

```text
$identity-pm
Take over the current project. BEYOND installation verification and project initialization are complete.
Read the current workbench and report only the main line, active tasks, paused tasks, and next action. Do not recreate, start, or resume tasks yet.
```

After confirming the list:

```text
Resume the original tasks that are still in progress. Keep paused tasks paused, and do not restart completed tasks.
```
