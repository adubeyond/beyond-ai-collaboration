# Real Case and 90-Second Demo

**English** | [简体中文](../真实案例与90秒演示.md)

This is not a concept animation or a test script presented as a customer story. The flow below comes from real BEYOND 3.2.2 validation on Windows, Codex Desktop, and a local Node.js fixture. Private project names, absolute paths, and thread IDs are omitted.

## 90-second recording plan

| Time | Screen | Point to show |
| --- | --- | --- |
| 0–10s | The owner gives the PM an outcome, acceptance criteria, and authorization | State the result instead of designing a workflow first |
| 10–20s | The PM registers one Worker and ends the dispatch turn | The PM governs and accepts; it does not poll or shadow the Worker |
| 20–50s | The Worker implements one formatter, adds tests, and runs the full suite | One Worker continuously develops and verifies the result |
| 50–65s | The Worker freezes its final, stores a receipt, calls the PM back, and ends | The callback wakes the PM; the final and receipt carry the facts |
| 65–80s | The PM wakes automatically and verifies the formal result | “Code written” is not silently upgraded to “released” |
| 80–90s | The workbench shows one accepted and archived result, with no pending receipt | One result is accepted once and the main line can continue |

Record a real Codex task with real command output. Do not use a prebuilt animation as proof of product behavior, and do not edit failures or genuine pauses out of the recording.

## Case 1: normal completion and automatic closeout

The real objective was to add `formatEnvironmentKey` to a local CommonJS utility package and export it from the package entry.

Observed evidence:

- one formal Worker continuously implemented, tested, and created a local commit;
- the complete suite passed `25/25`, and `git diff --check` passed;
- one local commit was created;
- the Worker performed one receipt enqueue, one native callback, and one formal final;
- the Worker called no business tool after the callback;
- the PM performed one acceptance, one history archive, and one receipt acknowledgement;
- there was no correction turn, replacement Worker, duplicate acceptance, push, or release.

This proves a local “outcome → execution → evidence → return → acceptance” loop. It does not prove that the code was pushed, deployed, released, or production-ready.

## Case 2: a genuine pause resumed by the same Worker

Another task required a confirmation code from the owner. The Worker did not invent it. It produced a paused final, and the PM recorded the one blocking reason and recovery condition in the workbench.

After the owner provided `R7-OK-03`:

- the PM resumed the original Worker instead of creating a replacement task;
- that Worker returned `REQUEST-R7=R7-OK-03`;
- the pause and completion stages each used one receipt, one callback, and one control-plane transaction;
- final state was zero active records, one completed history record, and zero pending receipts;
- no result was accepted or archived twice.

A pause is therefore not a lost task. Work stops when a real business input is missing, then continues under the original owner when the input arrives.

## Reproduce the behavior

1. Install the release using the [Installation, Upgrade, and Project Initialization Guide](../../模板交付包/docs/en/installation-upgrade-and-project-initialization.md).
2. Adopt a clean local project with the [Quick Start](quick-start.md).
3. Give the PM a small verifiable outcome with explicit file, Git, and environment boundaries.
4. Check that the PM creates one formal Worker and ends its dispatch turn.
5. Check that the Worker freezes a self-contained result, stores a receipt, performs one callback, and then emits its formal final.
6. Check that the PM accepts and archives once, then removes the receipt after the workbench transaction succeeds.
7. Run a second task with one genuinely missing business input and confirm that the original Worker resumes after the input is supplied.

## What this evidence does not prove

- identical task and callback behavior across every Codex Desktop, CLI, or third-party platform version;
- that passing tests imply a push, deployment, release, or production result;
- project-specific permissions, server state, data safety, or rollback readiness;
- that one successful case eliminates every future platform-level intermittent failure.

BEYOND does not promise that nothing can fail. It aims to keep ownership, evidence, pause reasons, and recovery paths explicit, readable, and closeable.
