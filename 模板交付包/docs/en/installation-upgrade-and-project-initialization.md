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
→ record the user's full-or-on-demand initialization choice
→ start a new PM for the main line
```

The standard BEYOND path does not install an identity Hook and does not require `/hooks` or a guard probe. Use a new ordinary conversation without an identity Skill for installation maintenance so an active PM or Worker does not replace its own project entry while doing business work. Wait for active tasks to stop before replacing the root entry or Skills; after installation, restart Codex and verify the loaded version from a new process.

The runtime uses the existing fixed `runtime` entry for project identity, workbench transactions, and one short-lived Worker-result receipt. A Worker stores the exact frozen final before one native callback, then outputs the same user-visible final. PM removes the pending body only after the matching workbench update succeeds. This does not install a Hook, notify branch, daemon, or extra Codex CLI, and it does not retain a message archive.

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

Before initialization closes, run `worker-policy --action show --project-id <current-project>` and show the user the concrete model and reasoning parameters for both platform defaults and the BEYOND Worker matrix. Save only the user's explicit choice in the managed project-overview block. If the user does not choose, keep platform defaults without blocking other initialization or ordinary work.

```text
Confirm BEYOND-led AGENTS.md fusion while preserving the project's native rules.
Establish only the project entry and document foundation; do not start business tasks or push remote Git.
```

Fusion returns one explicit choice: complete initialization now, or start work and fill the remaining groups on demand. The PM records that choice in the project overview, then runs section 5 verification.

## 4. Adopt or upgrade an existing project

Open a new conversation at the existing project root:

```text
$identity-pm
Use BEYOND to adopt or upgrade this existing project.

First inspect the existing AGENTS.md, code and Git boundaries, Markdown documents, legacy workbench, and tasks that may still be running.
Do not reinstall, start, or resume business tasks. Ask me to confirm one migration or fusion decision at a time.
```

Confirm repository boundaries, active tasks, legacy-workbench migration, durable product and engineering fact locations, entry fusion, local/team identity, and the new-Worker policy. Run the fixed `worker-policy --action show` command before asking. A legacy model-policy line in the root override is only a migration candidate: it must not be silently inherited. After explicit user confirmation, move it into the managed project-overview block and remove the old root line in the same fusion action. When ready:

```text
Confirm BEYOND-led AGENTS.md fusion while preserving all native project rules and formal documents.
Back up the legacy workbench, move only truly active tasks into the current workbench, and archive completed or obsolete items without deleting conversations or evidence.
Remove only legacy BEYOND identity Hook content and preserve all other Hooks.
If a legacy Worker model policy is found, show the concrete fixed-script choices first, migrate my explicit selection into the project overview, and remove the old root override instead of retaining both.
Complete existing-project initialization only; do not start or resume business tasks or push remote Git.
```

After minimum adoption, run:

```powershell
node beyond-control/scripts/beyond-control.mjs initialization --action show --project-id "<project-id>"
```

Ask only the returned choice. For full initialization, process overview, architecture, development, testing, operations, security, and other project-specific material one group at a time. For on-demand completion, ordinary work may continue and the same command later resumes at the first pending group. A recorded entry must be an existing file inside the business project or control repository; except for the overview, the same entry must already appear in the project fact index. Mark initialization complete only after every group has a recorded decision and the root `AGENTS.md` retains only stable boundaries and fact entry points. Then show the current main line, active tasks, backlog/history, fact locations, and remaining unknowns.

The fixed write actions are `initialization --action choose`, `record`, and `complete`; run `help` for their parameters. `record` validates the file and fact-index link, while `complete` revalidates every entry and requires `--root-entry-reviewed yes`. The PM executes only the one action the user has currently approved. Users do not need to enter commands or remember group state.

## 5. Verify installation

From the project root, run:

```powershell
node beyond-control/scripts/verify-install-integrity.mjs --installed-skills-root "<Codex Skills directory>" --project-agents "<business-project-root>/AGENTS.md"
```

Installation is verified only when it exits `0` and confirms matching Skills, control structure, and project runtime entry. It also rejects remaining legacy BEYOND guard content. `--content-only` checks candidate content only; it does not prove project fusion.

Third-party Hooks are preserved and are not BEYOND verification targets. If a legacy BEYOND guard remains, rerun the fixed existing-project fusion path instead of deleting the whole `.codex` directory.

## 6. Let a PM take over

After installation verification, minimum adoption, and the user's initialization choice, start a new PM at the project root. Complete all groups first when the user selected full initialization; when the user selected on-demand completion, ordinary work may begin and initialization can resume later. Ordinary project-document edits do not force a restart. Replacing the root entry or Skills does: restart Codex and confirm the loaded version from a new process.

```text
$identity-pm
Take over the current project. BEYOND installation verification and minimum adoption are complete; use the project overview to distinguish complete initialization from on-demand completion.
Read the current workbench and report only the main line, active tasks, paused tasks, and next action. Do not recreate, start, or resume tasks yet.
```

After confirming the list:

```text
Resume the original tasks that are still in progress. Keep paused tasks paused, and do not restart completed tasks.
```
