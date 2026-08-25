# BEYOND 3.2.3 Quick Start

This page is for the minimal fixture. For real-project installation, upgrades, new/existing-project initialization, and copy-ready prompts, use the [Installation, Upgrade, and Project Initialization Guide](../../模板交付包/docs/en/installation-upgrade-and-project-initialization.md) instead of assembling an adoption sequence from this example.

**English** | [简体中文](../快速开始.md)

This guide uses the repository's zero-dependency Node.js fixture to verify three things:

1. The template can enter a clean project.
2. Codex can understand the project through a fused root `AGENTS.md` and the external document chain.
3. One clear development task can move through design, development, testing, evidence, and write-back without repeated stage routing.

The guide does not touch a real server, database, production environment, or remote Git repository.

## Requirements

- A Codex environment that can read project `AGENTS.md` files and use Skills.
- Node.js 18 or later. The fixture uses only built-in modules and needs no `npm install`.
- A writable local directory.

If you want to invoke `$identity-pm`, `$identity-worker`, and `$task-*` directly, install the six Skills from this repository. Restart Codex after the first installation or any replacement of global Skills. A restart is unnecessary when only project-local `SKILL.md` files are referenced and the global copies did not change.

Confirm the environment:

```text
node --version
npm --version
```

## Prepare the demo project

Copy [`examples/minimal-project`](../../examples/minimal-project) to a new writable directory such as `beyond-demo`.

Copy the complete [control-repository package](../../模板交付包) into the demo root and name it `beyond-control`. Keep it as one independent directory instead of scattering BEYOND files across the business project:

```text
workspace/
beyond-demo/
├─ beyond-control/
└─ <existing code and documents>
```

Initialize the control repository, inspect the business project, and install the fused project entry only after explicitly confirming BEYOND-led fusion:

```text
cd beyond-demo
node beyond-control/scripts/beyond-control.mjs init-control --project-root "."
node beyond-control/scripts/beyond-control.mjs inspect-project --project-root "."
node beyond-control/scripts/beyond-control.mjs install-project-entry --project-root "." --confirm-fusion yes
```

Existing-project inspection prioritizes formal documents, legacy workbenches, nested repositories, and duplicate remotes. If active legacy tasks exist, add `--adopt-legacy-workbench yes`; if the same remote has multiple local directories, select exactly one path per duplicate-remote group with `--canonical-repositories "<path1>,<path2>"`. The script will not silently replace those facts with an empty workbench.

The business project receives the fused root `AGENTS.md`. Existing third-party Hooks are preserved; a legacy BEYOND identity guard is removed precisely during migration. BEYOND documents and project registration remain in the project-local control repository; the personal workbench is under its Git-ignored `local/`. When the project root is a Git repository, initialization also ignores `/beyond-control/` and `/.beyond-local-backups/` there so neither the independent control repository nor local backups are accidentally staged as business code. Empty project facts are expected and must not be filled with guesses.

Local fusion does not push automatically. The fixed script creates a shared project record, a minimal project overview, and a minimal facts index so the fused entry is immediately reachable. If teammates need them, authorize remote Git separately, then use the `project-registration` scope to push only these three foundation files for the same project.

An unadopted project does not yet have the BEYOND root entry. Start with `$identity-pm`, then use `Use BEYOND to initialize this new project.` or `Use BEYOND to adopt or upgrade this existing project.` Inspect code, Git, `AGENTS.md`, and Markdown first for an existing project, then ask the user to confirm each fusion or migration group. Do not overwrite or delete the original documentation tree automatically. This compatibility check is not part of the normal task hot path.

## Install the Skills

Install or explicitly reference these six directories from `beyond-control/skills/`:

```text
identity-pm
identity-worker
task-design
task-dev
task-test
task-ops
```

Verify the actual installed copy from the immutable release checkout:

```text
node beyond-control/scripts/verify-install-integrity.mjs --installed-skills-root "<Codex Skills directory>" --project-agents "<business project root>/AGENTS.md"
```

The on-disk installation is complete only when this command exits with code `0` and confirms that all six Skills, the control-repository structure, and the full project runtime kernel match with no legacy BEYOND Hook content. `--content-only` checks candidate content but does not prove project fusion. Restart Codex after installing or replacing global Skills, then create a new task from the demo root.

## Run the initial baseline

From the demo root:

```text
npm test
npm run check
```

Expected result:

- `npm test` passes the existing `add` test.
- `npm run check` passes syntax checks for source and test files.
- No `node_modules` or lockfile is created.

If the baseline fails, repair the Node.js environment or fixture first. Do not report a pre-existing baseline failure as a development regression.

## Start the PM and assign the first task

Send this message in a new Codex task opened at the demo root:

```text
$identity-pm Take control of the current project as the PM.

This is the minimal calculator project used to verify BEYOND.
Business result: add subtract(left, right) to src/calc.js and add a test proving subtract(5, 2) === 3 in test/calc.test.js.
Explicit non-goals: do not add multiplication, division, a command-line interface, dependencies, or unrelated files; do not use Git; do not deploy.
Allowed actions: read the current project; modify src/calc.js, test/calc.test.js, and the project documents defined by the template; run npm test and npm run check.
Acceptance: both commands exit with code 0, the existing add test still passes, and the new subtract test passes.

Follow the minimum read path in the root AGENTS.md. Record one task in the workbench and create one Worker with the compact task packet plus its `projectId + taskId` control line. The Worker must remain responsible for the result and combine design, development, and testing as needed. Return the formal result and current-run evidence to the PM. Write reusable engineering facts only when the task actually confirms them; do not create a capability-initialization task.
```

The message deliberately supplies the business result, non-goals, file boundary, command permissions, and acceptance criteria. It tests the complete automatic path rather than the PM's ability to ask many questions.

## Expected flow

```mermaid
flowchart LR
    A["PM minimum read"] --> B["Record task in workbench"]
    B --> C["Create Worker with six-field packet"]
    C --> D["Worker reads relevant project facts"]
    D --> E["Implement subtract and its test"]
    E --> F["npm test"]
    F -->|"failed"| E
    F -->|"passed"| G["npm run check"]
    G -->|"passed"| H["Freeze final and save short-lived receipt"]
    H --> J["Use callback as the last tool call, then output final"]
    J --> I["PM verifies, accepts, and removes receipt"]
```

Normal behavior:

- The PM does not modify `src/calc.js` or the test file.
- Design, development, and testing are not split into three business tasks that require repeated “continue” messages.
- Missing project facts do not block unrelated work. The Worker writes reusable facts in the original task only when they are actually confirmed.
- Ordinary implementation or test failures are repaired and retested in the same task.
- Git, dependencies, servers, production, and data remain untouched because they were not authorized.

### Execution decisions in 3.2.3

- When the current instruction already defines the result, boundary, and acceptance criteria, the PM and Worker take the shortest viable path instead of adding questions or stages for BEYOND defaults.
- When wording such as “optimize this” can lead to materially different outcomes, ask one result-changing question. Investigate technical details that the project itself can answer instead of sending them back to the user.
- Current explicit authorization may override ordinary CLI-versus-browser preferences, but it does not expand into credentials, production, shared data, or destructive operations that were not authorized.
- Prefer a CLI when it provides the same capability. Use a browser when the user explicitly requests it or the task depends on an existing signed-in session, extension, or visible UI state.
- The PM passes the same business result and boundary to the Worker. The Worker must not narrow current authorization by reviving stale habits, historical preferences, or extra process.
- When current evidence disproves one route, return to the goal and choose the smallest viable alternative instead of repeating the same failure or expanding into unrelated redesign.

## Verify the result

Run again:

```text
npm test
npm run check
```

Also verify:

- `src/calc.js` exports both `add` and `subtract`.
- `test/calc.test.js` covers `add(2, 3) === 5` and `subtract(5, 2) === 3`.
- The PM workbench records one formal task, its Worker, progress, and completion instead of doing the implementation itself.
- The formal task contains implementation, current-run validation, and completion evidence.
- A new Worker saves a short-lived receipt matching the formal final before calling the PM back; the PM removes it after the matching workbench transaction succeeds instead of retaining a second result archive.
- Project documents contain only investigated or verified facts.
- Git, services, network, servers, production, and data show zero operations.

For a second run, keep the control repository, delete only the disposable demo directory, create a fresh fixture copy, and fuse its project entry again. Do not force-clean a directory containing personal work, and do not copy runtime facts back into this repository's original fixture.

Continue with the [Architecture Overview](architecture.md) before adopting BEYOND in a real project.
