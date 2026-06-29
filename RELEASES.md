# Releases

Release log for the **adversarial-code-review** plugin. Newest first. The forward-looking
plan lives in [ROADMAP.md](ROADMAP.md). Source-of-truth version: `.claude-plugin/plugin.json`.

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
