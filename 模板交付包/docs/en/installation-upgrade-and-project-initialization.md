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

BEYOND 3.2.5 does not install a terminal-result Hook, notify branch, background process, or extra Codex CLI. Formal results remain in user-visible Codex Worker tasks. Only the [Worker identity rules](../../skills/identity-worker/SKILL.md) own terminal formation and the native callback; only [PM pause, resume, and closeout](../../skills/identity-pm/references/lifecycle-and-closeout.md) owns matching, acceptance, pause, and receipt consumption. This installation guide describes what to install and verify; it does not copy the pending-scan, Worker-read, or workbench-transaction algorithm. An upgrade replaces the control repository and six Skills, then verifies the loaded version after restart. The upgrade maintenance path backs up and removes only a legacy BEYOND notify branch, without changing other plugins or user-owned notify configuration.

## 2. Prepare the target release

BEYOND 3.2.5 is still a pre-release candidate. Until it is formally released, the immutable public stable artifacts remain 3.2.4:

- Release: <https://github.com/adubeyond/beyond-ai-collaboration/releases/tag/v3.2.4>
- Package: <https://github.com/adubeyond/beyond-ai-collaboration/releases/download/v3.2.4/BEYOND-3.2.4.zip>
- Optional SHA-256 file: <https://github.com/adubeyond/beyond-ai-collaboration/releases/download/v3.2.4/BEYOND-3.2.4.zip.sha256>

Only the ZIP is required on Windows. If the optional checksum file is already present beside it, verify it without using a web UI for Git operations:

```powershell
curl.exe -L "https://github.com/adubeyond/beyond-ai-collaboration/releases/download/v3.2.4/BEYOND-3.2.4.zip" -o "BEYOND-3.2.4.zip"
$checksumPath = ".\BEYOND-3.2.4.zip.sha256"
if (Test-Path -LiteralPath $checksumPath) {
  $expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath ".\BEYOND-3.2.4.zip" -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) { throw "BEYOND-3.2.4.zip SHA-256 mismatch" }
} else {
  Write-Warning "Optional SHA-256 file not supplied; continue and complete the in-package and installed-content checks"
}
Expand-Archive -LiteralPath ".\BEYOND-3.2.4.zip" -DestinationPath ".\BEYOND-3.2.4-install"
```

On Linux or macOS:

```bash
curl -L "https://github.com/adubeyond/beyond-ai-collaboration/releases/download/v3.2.4/BEYOND-3.2.4.zip" -o BEYOND-3.2.4.zip
if [ -f BEYOND-3.2.4.zip.sha256 ]; then sha256sum -c BEYOND-3.2.4.zip.sha256 || exit 1; else echo "optional SHA-256 file not supplied; continuing to in-package verification"; fi
unzip BEYOND-3.2.4.zip -d BEYOND-3.2.4-install
```

The ZIP is required; the external SHA-256 file is optional verification material. A missing or unavailable checksum file does not block installation, but a supplied checksum that does not match must stop it. With or without the external checksum, verify the in-package content manifest and the final installed content. Extraction produces one complete `beyond-control/` directory. Put that directory under the business-project root instead of scattering package files over the project.

Install these six directories from `beyond-control/skills/` into the active Codex Skills directory:

```text
identity-pm
identity-worker
task-design
task-dev
task-test
task-ops
```

During an upgrade, preserve real content under `local/`, `projects/`, and `shared/`. The fixed fusion path automatically investigates only the project root itself and exact Git roots that are direct children. Register every other formal component repository, including deeper nested repositories and repositories outside the project root, explicitly with `--repository-roots`. Do not copy `beyond-control` into each business repository and do not create a worktree for installation.

For a cross-root or multi-repository project, or a project that must support an existing platform worktree, obtain the actual host ID and Codex project ID from the current Codex project and pass them during first fusion as `--host-id` and `--codex-project-id`; never guess them. Later upgrades preserve previously registered external repository roots and platform bindings when those flags are omitted. If a registered path is missing, is no longer an exact Git root, or its origin remote has drifted, stop and request an explicit decision instead of silently rewriting the registration.

If an existing `.codex/hooks.json` references `beyond-runtime-guard.mjs`, the fixed script removes only those legacy BEYOND handlers after backup. Other Hooks and `.codex` files remain unchanged.

Installation maintenance is file-level copying, entry fusion, and verification; the business project does not need to be a Git repository. Resolve the project root from the current Codex project directory and its root `AGENTS.md`; never make a successful `git rev-parse` a prerequisite. An upgrade rollback preimage covers only objects that this run will actually replace or fuse: the project-root `AGENTS.md`, candidate product paths that will be overwritten in the existing project, and the six user Skills. Record a candidate path that did not previously exist so rollback can remove it precisely. `beyond-control/local/**`, `projects/**`, `shared/**`, `.git/**`, and business code are preserved in place and are outside both the overwrite set and the backup-permission gate; do not recursively enumerate, copy, or change permissions on them. Stop only when an actual overwrite target is unreadable. On Windows, backup inventories for the actual overwrite set must include hidden files and directories. For directory targets, use `Get-ChildItem -Force -Recurse -File` or an equivalent relative-path, byte-count, and SHA-256 comparison on both sides. A changed Hidden attribute on a directory is not evidence that file content was lost.

Prompt for an AI-assisted maintenance conversation:

```text
This is BEYOND installation maintenance. Do not create a PM, Worker, or business task.
Install or upgrade the current project's beyond-control directory and six global Skills from the official BEYOND 3.2.4 release. If BEYOND-3.2.4.zip.sha256 is present beside the ZIP, verify it; if it is absent, do not block installation, but still complete the in-package manifest and final installed-content checks. Install a v3.2.5 pre-release candidate only through the candidate-root directed test guide; it is not an official Release.
The project may be non-Git. Resolve its root from the current Codex project directory and root AGENTS.md; do not run or depend on a git rev-parse gate.
The fixed entry discovers only the project root itself and exact Git roots that are direct children. Pass every confirmed formal repository that is deeper or outside the project root through --repository-roots. Do not copy beyond-control into each business repository and do not create a worktree for installation.
For cross-root, multi-repository, or existing-worktree use, obtain the actual hostId and Codex projectId from the current Codex project and pass --host-id and --codex-project-id during first fusion; never guess them. Later upgrades preserve registered external roots and platform bindings when those flags are omitted. Stop and request a decision if a path, exact Git root, or origin remote has drifted.
Back up only the project entry, candidate product paths, and six user Skills that this run will actually overwrite; record candidate paths that were previously absent. Preserve native rules and real local, projects, shared, .git, and business-code content in place. Do not enumerate or copy those preserved roots, never replace them with empty templates, and do not treat an unreadable cache inside them as an installation blocker.
On Windows, inventory actual overwrite targets on both sides with hidden entries included, and compare relative paths, bytes, and SHA-256. Do not fail an otherwise identical backup only because a directory lost its Hidden attribute.
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

Installation is verified only when it exits `0` and confirms matching Skills, control structure, and project runtime entry. It also rejects remaining legacy BEYOND guard content. `--content-only` checks candidate content only; it does not prove project fusion. Restart Codex after the on-disk check and confirm the project identity and loaded release from a new process.

An ordinary installation does not require the user to rerun the release-qualification matrix for normal completion, genuine pause, busy-PM handling, parallel closeout, and multi-stage recovery. Those are release gates. For a first adoption or a suspected host-callback problem, use only one no-business-write smoke Worker to verify `receipt enqueue → native callback → final → PM acceptance → receipt removal`.

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
