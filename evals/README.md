# Eval harness

Measures review *quality* — recall/precision/verify-pass value against seeded bugs — as opposed
to `tests/`, which only checks that the pipeline's plumbing doesn't crash. This is the regression
gate for prompt/doctrine changes (reviewer prompts, `agents/doctrine/`, `triage.mjs` wiring): a
change that drops recall on this scoreboard is a quality regression, full stop, even if every unit
test stays green.

## Layout

- `cases/<name>.json` — one seeded-bug case: `{ name, dir, seeded: [{file, line, class,
  description}], cleanFiles: [...] }`. `dir` points at a fixture folder under `fixtures/`; `file`
  paths in `seeded`/`cleanFiles` are relative to it.
- `fixtures/<name>/` — small, self-contained source files. Each seeded-bug file has one planted
  defect at a known line; each case also carries a clean companion file (or, for the two
  clean-only cases, is entirely clean) to test that a reviewer doesn't invent findings on
  unrelated code sitting in the same change.
- `run.mjs` — builds a throwaway git repo per case (an empty base commit + one commit that adds
  every seeded and clean file — that commit is the diff under review) and runs the pipeline
  against it.
- `score.mjs` — pure matcher + scorer (unit tested in `tests/evals.test.mjs`), plus a thin CLI/main
  that writes the scoreboard.
- `results/<label>.json` + `results/<label>.md` — one scored run. Not checked in (generated
  per-run); only `results/.gitkeep` is tracked. `label` is supplied by the caller (an ISO date, a
  git sha, a prompt-version tag) — `score.mjs` never calls `Date.now()` itself, so re-scoring the
  same recorded run data is byte-for-byte reproducible.

## What actually runs today

`run.mjs` always runs the **deterministic layers for real** against each case's throwaway repo —
`../lib/plan.mjs` (tiering/dimension selection) and `../lib/capture-diff.mjs` (diff capture) — so a
change that breaks those against realistic small diffs is caught here, not just in a unit test with
a synthetic fixture.

The **model-gated layer** — the actual dimension review that produces findings to score against
the seeded bugs — is off by default. Model access is never assumed: without it, every case is
marked `skipped` with a reason, and the script still completes normally (exit 0). This is the path
exercised in CI / `npm test`.

To attempt a live pass locally: `ACR_EVAL_LIVE=1 node evals/run.mjs` (requires the `claude` CLI on
`PATH` and configured credentials). Each live call is timeout-bounded and degrades to the same
`skipped` shape on any failure — a hung or unauthenticated CLI can't stall the harness. The current
live path is a minimal, single-prompt review of each case's changed files (not the full triage →
fan-out → verify pipeline) — a useful cheap proxy for raw model catch-rate, not a substitute for
running the real `/review` end to end against these fixtures.

## Using this as a regression gate

1. Before changing a reviewer prompt / `agents/doctrine/*` / triage wiring, run a live baseline
   and keep its `results/<label>.json`.
2. After the change, run again with a new label.
3. Compare `aggregate.meanRecall` between the two — it must not drop. A precision drop is a
   quality regression too, but recall (missed bugs) is the harder failure mode to catch after the
   fact, so treat it as the hard gate.
4. `scoreVerifyPass`'s `value` (FPs killed minus true findings wrongly dropped) is the check for
   verify-layer regressions specifically — a prompt change that makes the verifier trigger-happy
   shows up as `wronglyDropped` rising even if recall on the *unverified* findings holds steady.

## Adding a case

1. Add `fixtures/<name>/<file>.mjs` with the bug at a specific line, plus (optionally) a clean
   companion file in the same folder.
2. Add `cases/<name>.json` pointing at it. `line` should be the line a reviewer would most
   naturally cite (the statement with the defect, or the enclosing declaration for a
   whole-function-shaped bug like a missing migration `down()`).
3. If the bug class doesn't fit an existing entry in `score.mjs`'s `CLASS_KEYWORDS`, either add
   one (a few lowercase keywords a finding's title/evidence/fix would plausibly contain) or leave
   it unlisted — an unlisted class matches on file+line alone.
