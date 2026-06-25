# adversarial-code-review

Advisory, criticality-aware code review plugin for Claude Code. Reads a diff, scales review depth to risk, adversarially verifies the unsure findings, and reports them. **It never edits the code under review.**

## Golden rules

1. **Advisory, never edits source.** No `lib/` module may write to a reviewed file. The only writes allowed are review artifacts under `.adverserial-code-review/` (reports via `report.mjs`, the learnings store via `memory.mjs`) and detached git worktrees via `worktree.mjs`. Findings carry a `fix` suggestion — rendered as text, never applied. This invariant is stamped into user-facing output (`render.mjs` HTML footer, `comments.mjs` PR-comment footer); keep it true.
2. **Zero runtime dependencies.** Import `node:` builtins only. No npm packages, no flag-parsing libs, no test frameworks. `package.json` has no `dependencies`.
3. **Degrade to a skip note — never crash mid-run.** Probe for optional tools (`have('npm')`, `has('gh')`) up front; when something is missing or fails, push a human-readable string onto a `notes`/`skipped`/`warn` collection and keep going. Hard failure (`process.exit(1)`) is reserved for genuinely required tools (git), via `preflight.mjs`.
4. **Determinism.** No `Date`/random in any function that generates an identity (e.g. `worktreeName`). Stable sorts use an explicit tie-break key.

## Module convention (`lib/*.mjs`)

Every module is one pipeline step, named for its verb (`scan`, `gather`, `triage`, `verify`, `render`, …). Shape:

- **Runnable modules**: `#!/usr/bin/env node` shebang → header comment block (`CLI:` purpose, `Usage:` line, what it reads/prints) → **pure exported functions first** → thin `main` last, guarded by `if (import.meta.url === \`file://${process.argv[1]}\`)`.
- `main` parses argv with a tiny local `arg(name, def)` helper (no flag library) or reads JSON from stdin, calls the pure functions, and writes one pretty-printed JSON object: `process.stdout.write(JSON.stringify(out, null, 2) + '\n')`.
- **Pure-only modules** (`signals.mjs`, `shard.mjs`, `triage.mjs`): no shebang, no `main` — just exported pure functions, with a leading `// Pure:` comment.
- Export every non-trivial helper so it is unit-testable. Naming: `lowerCamelCase` verb-first functions, `SCREAMING_SNAKE_CASE` constants/tables, `<verb>Args` for functions that build CLI/git argv arrays.
- Config is read optionally from `.adverserial-code-review/config.json` inside a try/catch defaulting to `{}`; every key has an inline `?? default`.
- Exit codes: `2` = usage/argument error, `1` = hard failure / gate BLOCK, `0` = success.
- Comments explain the **why** (the policy, the cost-of-miss tradeoff), not the mechanics.
- **Workflow-DSL exception**: `lib/review-workflow.mjs` is NOT a pipeline-step module — it has no shebang/`main` and uses the harness Workflow globals (`agent`/`pipeline`/`phase`/`args`). It cannot be `import`ed or run with `node`; it inlines the pure helpers whose canonical, tested copies live in `lib/review-orchestration.mjs` (orchestration helpers) and `lib/verify.mjs` (the verification policy — `verifyPolicy`/`selectForVerification`/`resolveVerification`/`partition`, run inline instead of via an executor agent). Keep the inlined copies in sync with their canonical sources.

## Where things live

- **Review dimensions** (`Dn` ids) are defined in `lib/triage.mjs` — `DIMENSION_AGENTS`, `DIMENSION_LABELS`, `TIER_DIMENSIONS`, `OPUS_DIMS`, and the content gates in `planReview()`. Not in `config.schema.json` (it has no dimension enum) and not in `render.mjs` (it imports the maps). To add one, use `/add-reviewer-dimension`.
- **Bundled agents** live in `agents/`. The dimension reviewers (`*-reviewer.md`) share one finding contract; the pipeline agents (`intent-*`, `triage-classifier`, `business-logic-analyzer`, `*-verifier`, `completeness-critic`, `review-synthesizer`) each use their own JSON shape by design.
- **Severity vocabulary is fixed**: `critical | important | minor | suggestion` (lowercase). Never introduce `high`/`med`/`low`/`info`. The full finding contract is enforced by the `dimension-agent-consistency` agent — run it if you touch a reviewer's output.
- **Review orchestration** is a Workflow (`lib/review-workflow.mjs`), invoked by `commands/review.md`. The main agent only runs the deterministic scripts + the Workflow call; it never assembles the `report.mjs` payload by hand.

## Testing

`npm test` → `node --test` (built-in runner, no framework). Test files: `tests/<topic>.test.mjs`, importing `node:test` + `node:assert/strict`. Two layers: unit tests on the pure exports, and CLI smoke tests (`tests/cli.test.mjs`) that spawn each script via `process.execPath` and assert on the parsed JSON stdout. No network, no deps. Fixtures: JSON change-objects under `fixtures/cases/`.

## Versioning

The version is duplicated across the plugin manifests and they must agree (the `check-versions` hook flags drift). Source of truth: `.claude-plugin/plugin.json`. Use `/release-plugin` to bump them together and cut a release.

## Keep the docs current

`README.md` and `docs/ARCHITECTURE.md` are the user-facing contract. **When you change behavior, update them in the same change** — run `/sync-docs`, which maps each kind of code change to the doc sections it affects.

## Project skills

- `/add-reviewer-dimension` — scaffold a new dimension end to end (agent file + `triage.mjs` wiring + docs).
- `/release-plugin` — bump the version across every manifest, update the Roadmap, test, commit, tag.
- `/sync-docs` — reconcile `README.md` + `docs/ARCHITECTURE.md` with the current code.
