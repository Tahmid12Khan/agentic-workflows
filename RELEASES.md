# Releases

Release log for the **adversarial-code-review** plugin. Newest first. The forward-looking
plan lives in [ROADMAP.md](ROADMAP.md). Source-of-truth version: `.claude-plugin/plugin.json`.

## v0.12.0

- **One-click GitHub suggestion blocks** (`lib/comments.mjs`, `lib/review-workflow.mjs`, all `agents/*-reviewer.md`): findings can now carry `fixCode` (an exact, letter-for-letter replacement) and `endLine` (for a fix spanning several contiguous original lines). `--comment` renders these as a real ```` ```suggestion ```` block GitHub can apply in one click — single-line at `line`, or multi-line via `start_line`/`start_side` — instead of a prose-only "Suggested fix". Falls back to the one-line prose `fix` when a reviewer isn't letter-for-letter confident. New exports `commentLocation` and `buildCommentArgs`; dedup now keys off the comment's visible anchor line (`endLine` when set).
- **Tests** (`tests/v2.test.mjs`): 4 tests added covering the suggestion-block render, `commentLocation`, `buildCommentArgs`, and multi-line dedup.
- **Docs** (`README.md`, `docs/ARCHITECTURE.md`): `--comment` description updated to mention one-click suggestion blocks.

## v0.11.0

- **`lib/build-args.mjs`** (new module): deterministic pre-step assembler that reads plan/bundle/diff/routing/meta/enrich from `$SCRATCH` files and emits the exact args object `review-workflow.mjs` destructures — without routing any large blob through the main agent's context window. The diff (the dominant token cost) is read from disk here and never enters agent context. Exports `buildArgs` and `mergeEnrich` (shallow-merge for agent-fetched dynamic enrichment); CLI exits `2` on missing required inputs.
- **`commands/review.md` — token-discipline refactor**: all large pre-step outputs (plan, bundle, diff, routing) are now redirected to `$SCRATCH` files; the agent reads no blob directly. Tier is extracted with a one-field `node -e` eval; dynamic MCP enrichment writes a small `enrich.json` that `build-args.mjs` merges. The Workflow `args` value is assembled via `node "$LIB/build-args.mjs" --dir "$SCRATCH"` and read back once — removing the hand-assembly that previously forced the 40–60 KB plan+bundle+diff into agent context on every review.
- **Tests** (`tests/build-args.test.mjs`): 5 tests covering `mergeEnrich` null-safety, `buildArgs` key contract and safe defaults, CLI enrich merge, and CLI exit-2 on missing required input.
- **Docs** (`README.md`, `docs/ARCHITECTURE.md`): `build-args.mjs` row added to the module tables.

## v0.10.0

- **Unsharded D3 security pass** (`lib/review-orchestration.mjs`, `lib/review-workflow.mjs`): `expandAspects` gains an `{ unsharded }` option; D3/security now runs as a **single aspect over all changed files** instead of one aspect per shard. On a sharded diff, the old behaviour re-paid the full diff N times (D3 ignores the shard scope to preserve cross-file taint); collapsing to one aspect eliminates that multiplied cost while keeping full-diff taint analysis intact. Inlined copy in `review-workflow.mjs` kept in sync.
- **Structured intent harvest** (`lib/review-workflow.mjs`): `intent-harvester` is now called with `HARVEST_SCHEMA`, forcing its output to a validated JSON object. A `harvesterBrief` (criteria + mismatches + scrutiny-flagged groups only) is derived from the structured result and passed to dimension reviewers and the completeness-critic; the bulky prose fields (`statedIntent`/`derivedIntent`/`expectedTests`/`outOfScope`) reach only the deep consumers (business-logic, synthesizer). Previously the raw free-form text was broadcast verbatim into every reviewer prompt.
- **Reviewer prompt-cache ordering** (`lib/review-workflow.mjs`): the reviewer prompt now leads with the shared, byte-identical blocks (intent brief + project rules) and trails with the per-aspect payload (diff, then dimension + file list). Shared prefix is now eligible for cache reuse across every aspect of the same reviewer agent — same cache trick already used by the intent and verify passes.
- **Test coverage** (`tests/review-orchestration.test.mjs`): new test asserting `expandAspects` collapses unsharded dimensions to one all-files aspect while leaving other dimensions sharded normally.

## v0.9.0

- **`intent-grouper` folded into `intent-harvester`** (`agents/intent-harvester.md`, `lib/review-workflow.mjs`, `lib/render.mjs`): the former `intent-grouper` agent is eliminated; `intent-harvester` now produces both the acceptance-criteria model (stated vs derived intent, mismatches) and the primary-vs-extra intent grouping in a single pass. Agent count drops from 22 to 21. The `groups` and `extraIntents` fields are new in the harvester's JSON output; downstream review agents consume them directly.
- **`stripNoise` for Intent-phase diffs** (`lib/trim-diff.mjs`): new `stripNoise(diff)` function strips mechanically-generated / vendored sections (lockfiles, build artifacts, sourcemaps, snapshots) from the diff before it reaches the Intent-phase agents — none of them review a lockfile, and a dependency bump is already signalled elsewhere (`depsChanged → D15`). Falls back to the full diff if stripping would drop everything or the input isn't a parseable git diff. 6 tests added.
- **`NOISE_RE` single source of truth** (`lib/trim-diff.mjs` → `lib/plan.mjs`): the noise regex that `plan.mjs` used to duplicate inline is now exported as `NOISE_RE` from `lib/trim-diff.mjs` and imported by `plan.mjs`, so the file-list filter and the diff-strip agree on what "noise" is.
- **Diff-first prompt caching for Intent phase** (`lib/review-workflow.mjs`): the intent-harvester and business-logic-analyzer calls now receive the (noise-stripped) diff as the *first* token in the prompt — a constant prefix shared between both calls — so the dominant diff input prompt-caches across the two agents rather than being re-read twice.

## v0.8.1

- **Token usage + USD cost panel** (`lib/usage.mjs`): `review.html` now shows a top-left panel with the input, cache-read, cache-write, and output token counts plus the USD cost for this review run. The cost is summed from the session's main transcript and all subagent transcripts (`<session>.jsonl` + `<session>/subagents/agent-*.jsonl`) within the review's time window. Best-effort: degrades to a note and no panel when transcripts aren't reachable — never fails the report. Pricing defaults cover Opus, Sonnet, Haiku, and Fable with the 5m/1h cache-write split; overridable per model-family per field via `usage.pricing` in config. Set `usage.enabled: false` to hide the panel entirely.

## v0.8.0

- **Cheap→strong verifier escalation** (`lib/verify.mjs`, `lib/review-workflow.mjs`): critical findings skip the cheap pass and go straight to `opus`; uncertain or hot-refuted verdicts (critical/important/high) from the cheap pass escalate automatically — the strong verdict is then authoritative. Configurable via `verify.model_first`, `verify.model_escalate`, and `verify.escalate_direct_severity` in config.
- **Per-finding diff scoping for verifiers**: verifiers now receive only the hunks for the finding's own file (`filterDiff` file-scoped) instead of the full diff — a large token reduction. D3/taint-verifier keeps the full diff so cross-file source→sink tracing survives.
- **Summary points** (`agents/review-synthesizer.md`, `lib/render.mjs`): the synthesizer now emits a `summaryPoints` array (3–6 scannable bullets) alongside the one-sentence `summary`. Both MD and HTML reports render the bullets as a list under the headline, replacing the wall-of-paragraph verdict.
- **Verified-vs-trusted distinction** (`lib/render.mjs`): findings the verifier actually looked at show `verified ×N`; high-confidence findings that were trusted on reviewer confidence (the cost policy) show `trusted` — the absence of a verified tag is now explicit, never ambiguous.
- **Verify block propagation**: the finding schema now carries each finding's `verify` block through synthesis so the report can display per-finding verification state; synthesizer instructions updated to copy the block verbatim.
- **Policy correctness fix** (`lib/review-workflow.mjs`): `plan.verify` (already resolved to camelCase in `plan.mjs`) is merged directly over `DEFAULT_VERIFY`; the old `cleanVerify()` re-resolution — which silently reverted custom config back to defaults — is removed.
- **Prompt cache fix** (from v0.7.1 hotfix, now fully landed): verifier prompt puts the diff first (constant across findings) and the per-finding JSON last, making the shared prefix eligible for cache reuse.

## v0.7.1

- **Docs split** — the release log moved out of `README.md` into this file (`RELEASES.md`) and the forward-looking plan into [ROADMAP.md](ROADMAP.md); `README.md` now links to both instead of carrying a "Roadmap" section. No behavior change.

## v0.7.0

- **Review the latest pushed code by detaching HEAD, not a worktree** (`lib/checkout.mjs` replaces `worktree.mjs`): the old worktree was invisible to the reviewer subagents (their `Read`/`Grep` run in the main repo), so the pipeline now fetches the remote base/head and **detaches HEAD onto the head** — both the diff and the reviewers' own file reads see the real target — then **restores your original branch** afterward. A dirty working tree stops the run with a **stash-and-rerun** message (it never stashes for you). Config `worktree` → `checkout` (`{ enabled, remote }`); flag `--no-worktree` → `--no-checkout`. Also fixed the per-aspect progress labels showing `review:Dn:undefined` (shard field was read as `.id`, but shards are keyed `.label`).

## v0.6.0

- **Token-savings pass** (no quality loss): dimension reviewers now get a **shard-scoped diff** (`lib/trim-diff.mjs`) instead of the whole diff — the single dominant input-token cost — while D3/security and every verifier/completeness-critic keep the full diff so cross-file taint survives. The **report executor agent is gone**: `report.mjs` is now an exported `generateReport()` the `/review` command runs directly, degrading soft failures (memory, file write) to notes instead of crashing. `triage-classifier` is **skipped on the trivial tier** and no longer gets `plan.models` in its prompt; the **completeness-critic receives a digested findings list** (keeps `verdict`+`dimension`, drops the bulky `evidence`/`fix`, which still reach the synthesizer).

## v0.4.0

- **Plugin-namespaced agent dispatch**: the Workflow resolves every bundled agent through `pluginAgent()` (`adversarial-code-review:<name>`), fixing "agent type not found" on projects other than the plugin's own repo. **`triage-classifier` wired in** — a first-step judgment pass that flags a higher tier for the human and adds dimensions the rules missed as real review aspects. **`completeness-critic` wired in** — on exhaustive reviews, a false-negative guard that re-dispatches ≤6 targeted reviewers for missed dimensions/criteria/taint, whose new findings re-enter Verify. **Honest coverage report** — the "Agents & coverage" section now classifies RAN strictly by observed dispatch count, so a planned-but-never-dispatched agent no longer shows as "ran 0×".

## v0.3.1

- **Stale-base warning**: the worktree setup reports `behindBase` (commits the base has that the head hasn't integrated) and `/review` asks you to rebase/merge before reviewing, so the `base..head` diff isn't computed against a stale base (advisory — never hard-blocks). *(The worktree was replaced by an in-place HEAD checkout in v0.7.0.)*

## v0.3

- Workflow-based `/review` (thin dispatcher; fan-out + verify-all in `lib/review-workflow.mjs`); **verify-all** (every finding on non-trivial tiers gets its own dedicated verification agent, not just uncertain ones); `lib/review-orchestration.mjs` (canonical, unit-tested pure Workflow helpers); `report.mjs` API hardened (requires `plan+agentRuns`; dropped `--out`/`--html` flags).

## v0.2

- Bounded adversarial verify (code-enforced via `verify.mjs select`/`resolve`), full 17-dimension catalog, HTML report, **git-worktree review of the remote's latest pushed code** (replaced by an in-place HEAD checkout in v0.7.0), per-project memory, PR-comment ingestion, **MCP-based ClickUp/Jira ingestion (no API tokens)**, dependency CVE scan, large-diff sharding, intent grouping + deterministic extra-intent scrutiny & forced-check routing (`route.mjs`), aspect-budget ledger (≤3/aspect), business-logic open questions.
