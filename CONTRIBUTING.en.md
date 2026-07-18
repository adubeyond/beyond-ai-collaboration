# Contributing to BEYOND 3.0

**English** | [简体中文](CONTRIBUTING.md)

Thank you for helping improve BEYOND 3.0.

Issues and Pull Requests are open, but an open contribution path is not automatic acceptance. Every PR must pass public validation and human review. A maintainer may still decline a change because of product direction, mechanism consistency, compatibility, maintenance cost, or safety boundaries.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## How to contribute

- For bugs, documentation errors, and reproducible behavior deviations, open a Bug Issue.
- For new capabilities, mechanism changes, or large refactors, open a Feature Issue first and explain the problem, objective, and boundaries.
- Small documentation fixes and clear defects may go directly to a PR, but the validation method must still be stated.
- Do not disclose security details publicly. Follow the [Security Policy](SECURITY.en.md).

Search existing Issues and PRs before opening a new one.

## Contribution boundaries

The public repository accepts changes related to:

- Product documentation, quick starts, architecture, and public examples.
- General collaboration mechanisms, document templates, and Skill source under `模板交付包/`.
- Public validation, Issue/PR templates, and continuous integration.

Do not submit:

- Real project names, business data, customer information, servers, accounts, credentials, or production configuration.
- Local absolute paths, task or conversation identifiers, execution logs, or internal release snapshots.
- Fixed thresholds, procedures, or business rules that only apply to one private project.
- Code, documents, images, or other material you do not have the right to redistribute.

## Development and validation

Run the public-content check from the repository root:

```text
node scripts/check-public-content.mjs
```

Run the fixture baseline from `examples/minimal-project/`:

```text
npm test
npm run check
```

Changes under `模板交付包/skills/` must also provide:

1. A stable RED scenario that reproduces the problem before the change.
2. GREEN evidence for the same scenario after the change.
3. At least one adjacent regression scenario.
4. An explanation of the impact on triggering, control rights, authorization, stop conditions, and compatibility.

Do not weaken a gate, delete a failing assertion, or write private-project facts into the general template merely to make a test pass.

## Pull Request requirements

A PR must explain:

- The problem and related Issue.
- What the change does and explicitly does not do.
- Affected public paths and compatibility impact.
- Commands actually run, results, and necessary evidence.
- Any change to security, authorization, data, Git, or production boundaries.
- Remaining known limitations.

Keep one PR focused on one complete problem. Avoid mixing unrelated formatting, renaming, and mechanism changes.

Before merge, the PR must pass public GitHub Actions checks, resolve review findings, receive maintainer approval, contain no undisclosed sensitive information or authorization expansion, and fit the product's long-term direction. Passing tests alone does not guarantee merge or a response deadline.

## Contribution license

BEYOND uses the [Apache License 2.0](LICENSE). Unless a separate written agreement is made, contributions intentionally submitted and accepted by the project are provided under that license without additional terms. Contributors must have the right to provide their contribution.
