# Releases

Release log for the **adversarial-code-review** plugin. Newest first. The forward-looking
plan lives in [ROADMAP.md](ROADMAP.md). Source-of-truth version: `.claude-plugin/plugin.json`.

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
