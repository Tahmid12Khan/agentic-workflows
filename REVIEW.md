# Review mandates — adversarial-code-review

Highest-priority, review-specific rules. These outrank general conventions. Flag any violation.

## Always flag

- **Source edits.** No `lib/` module may author or persist a change to a reviewed file. Only writes allowed: artifacts under `.adversarial-code-review/`. A finding's `fix` is text, never applied.
- **New runtime deps.** Imports must be `node:` builtins only. Any npm import or a new `dependencies` entry in `package.json` is a violation.
- **Crash-on-missing-tool.** Optional tools must degrade to a `notes`/`skipped`/`warn` string, not throw. `process.exit(1)` only for genuinely required tools (git) via `preflight.mjs`.
- **Non-determinism in identity.** No `Date`/random in any function that builds an identity (e.g. `findingKey`). Stable sorts need an explicit tie-break key.
- **Severity vocab drift.** Only `critical | important | minor | suggestion` (lowercase). Reject `high`/`med`/`low`/`info`.
- **Inlined-copy drift.** Helpers inlined into `lib/review-workflow.mjs` must match their canonical source (`review-orchestration.mjs`, `verify.mjs`, `trim-diff.mjs`). Flag any divergence.

## Always require

- Pure `lib/` exports have unit tests (`tests/<topic>.test.mjs`).
- Behavior changes update `README.md` + `docs/ARCHITECTURE.md` in the same change.
- Version stays in sync across manifests (source of truth: `.claude-plugin/plugin.json`).

## Never flag (out of scope)

- Pre-existing dead code not touched by the diff.
- Style preferences that match surrounding code.
