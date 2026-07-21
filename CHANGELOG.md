# Changelog

All notable public changes to BEYOND are recorded in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and public versions use [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
