---
name: bring-us-upstream
description: Review t3codes upstream changes, explain what to port or skip, and get approval before implementation.
---

# Bring upstream changes

Use when asked to sync or port code from upstream.

## Review first

Before editing:

- Read repository instructions and identify the baseline and upstream ref or range.
- Inspect the actual diff and relevant code, tests, contracts, migrations, and docs.
- Check affected server, client, provider, persistence, and connection surfaces.
- Classify every change:
  - **Bring:** compatible and in scope.
  - **Skip:** conflicting, redundant, unsupported, risky, or out of scope.
  - **Decide:** requires a product, security, migration, or compatibility choice.
- Use source evidence. Do not rely on commit titles alone.

Do not edit, commit, push, or create a PR before approval.

## Present and wait

Show the user:

- the baseline and upstream range;
- proposed ports, behavior, affected surfaces, dependencies, and tests;
- skipped items with reasons;
- open decisions and non-goals;
- the exact implementation boundary.

Ask whether to approve all items, selected items, or a revised scope. Stop until the user answers.

## Implement after approval

Implement only approved items. If the scope expands, present a revised proposal first. Preserve local behavior, add focused tests, update docs when needed, and run targeted checks. Report what changed, what was skipped, validation, and remaining manual checks. Create a PR only when requested.
