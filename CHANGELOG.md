# Changelog

All notable public changes to BEYOND are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and public versions use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.3] - 2026-07-30

Version 3.0.2 was never tagged or published from the main branch. Its release branch was abandoned; 3.0.3 continues from 3.0.1 with an independently rebuilt and tested candidate.

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
