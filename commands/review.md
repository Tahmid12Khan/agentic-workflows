---
description: Advisory criticality-aware code review of the current branch diff, with bounded adversarial verification. Flags: --base <ref> --comment --gate --tier <t> --dimensions <list> --incremental --exhaustive.
---

Run a systematic, **advisory** code review of the current change. NEVER modify source code — report only.

Bundled scripts live under `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/`. Let `LIB` be that path. Run scripts with `node`.

**Hard limits (do not exceed):** for any single aspect — one dimension on one shard, the verification of one finding, or the scrutiny of one intent — dispatch **at most 3 subagents total**, and look at that aspect **at most 3 times total** (the original review + at most 2 verifier passes). Across the whole review you may use many subagents; never more than 3 on one aspect.

## 1. Preflight
Run `node "$LIB/preflight.mjs"`. If it exits non-zero, show the report and STOP.

## 2. Plan
Run `node "$LIB/plan.mjs" --base <ref-or-omit>` (pass through `--tier`/`--dimensions`/`--exhaustive` if supplied). Parse the JSON plan:
`{ base, head, range, tier, dimensions, dimensionLabels, agents, dimensionAgents, models, runVerify, verify, escalation, exhaustive, discovery, sharded, shards, scan, reportTargets, learning, notify, trackers, mandatoryChecks, gate, intentSources, projectRules, signals, diffSummary }`.
Print: `Tier: <tier>${exhaustive ? " (exhaustive)" : ""} | agents: <agents> | <diffSummary>`.

**`plan.discovery`** drives the Tier C ultrareview-parity passes — `{ exhaustive, maxRounds, completenessCritic, taint, generativeVerify, loopUntilDry }`. They are all on together when `plan.exhaustive` (auto at `critical`, or `--exhaustive`) and all off otherwise. Each step below that costs extra tokens is explicitly gated on the matching `plan.discovery.*` flag; when it is false, run the plain (cheap) path.

If `tier == "trivial"`: do one quick correctness/comment pass inline (no subagents), then jump to **step 8**. This is the over-review guard.

## 3. Gather context + memory
- Capture the diff: `git diff <base>..HEAD` (or per shard later).
- Run `node "$LIB/gather.mjs" --base <base>` → context bundle: `{ pr, existingComments, tickets, commits, rules, summary }` (PR body, **existing PR/inline comments**, linked ClickUp/Jira issues when enabled + token present, project rules). Tools missing → it degrades and notes the skip.
- If `learning.enabled`: `node "$LIB/memory.mjs" load <learning.store>` → prior learnings (recurring, accepted false-positives, open questions).
- `--incremental`: if `.review/last-review.json` exists, load it; later mark findings new vs carried-over so you only re-spend effort on new code.

## 4. Dependency / supply-chain scan
If `scan.deps`: run `node "$LIB/scan.mjs"` → `{ findings, notes }`. Seed the D15 findings; add each `note` to the report's skipped/coverage list.

## 5. Intent (skip for trivial)
Build an isolated packet (context bundle + diff summary + rules).
- First dispatch **intent-harvester** → `summary, statedIntent, derivedIntent, acceptanceCriteria, expectedTests, outOfScope, mismatches`.
- Then, concurrently (both consume the harvester's criteria): **intent-grouper** → `groups` (primary vs **extra** intents) + `extraIntents`, noting any group with `scrutinize: true`; and for `standard`+ tiers **business-logic-analyzer** → `model, assumptions, openQuestions, businessRisks`. Carry its `openQuestions` straight to `needsHuman` — never assume on a material ambiguity.

## 6. Review fan-out
Build an isolated reviewer packet: `{ summary + acceptanceCriteria + mismatches + relevant intent groups, project rules, the diff }`. Do NOT include this chat's history.

- Always dispatch **correctness-reviewer** (D1/D2/D12 + security & test screen).
- For each agent in `plan.agents`, dispatch it for its dimension(s) using `dimensionAgents`, **with the model in `plan.models[dimension]`** (so e.g. D6 runs on opus for a migration but sonnet otherwise). All bundled — they ship with the plugin. If the user has an even-more-specialized agent installed for a dimension, you may prefer it.
- **Sharding:** if `sharded`, run each dimension agent **once per shard** (each shard is its own aspect; ≤3 concurrent is fine), passing only that shard's files. This is how large diffs scale — no nested agents, just more aspects.
- **Extra-intent scrutiny (deterministic):** pipe the intent-grouper output to `node "$LIB/route.mjs" scrutiny` → `{ targets:[{label,files,reason}] }`. For each target, dispatch correctness-reviewer (or the matching specialist) at just those files — its own aspect.
- **Mandatory checks (deterministic):** `echo '{"mandatoryChecks":[...]}' | node "$LIB/route.mjs" checks` → `{ checks:[{check,dimension}] }`. Ensure each mapped dimension's agent runs (add it if the tier didn't plan it), and apply every check as a forced check regardless of tier.
- Run independent reviewers concurrently. Each returns `{ strengths, findings }`. Collect all.

**Loop-until-dry (Tier C — only if `plan.discovery.loopUntilDry`):** a single sweep misses the tail. Repeat the fan-out above for up to `plan.discovery.maxRounds` rounds. After each round, dedup new findings against everything seen so far by **`file:line:title`** (use the line — `memory.findingKey` is deliberately line-insensitive `file::title` for cross-run matching, so reusing it here would collapse two distinct same-title findings at different lines and falsely register a dry round); **stop as soon as a round adds nothing new** (a dry round — which can also happen because the spawn-ledger cap is reached for every remaining aspect). Every re-dispatch still goes through the spawn ledger below, so the per-aspect cap holds across rounds. Without the flag (the default for non-exhaustive reviews), run the fan-out exactly once — do NOT loop.

**Spawn-on-doubt (bounded + accounted):** if a reviewer marks findings `uncertain: true`, or you are genuinely unsure about one specific aspect, you MAY fan extra reviewers **at that one aspect only**. Keep one ledger keyed by aspect (e.g. `review:D7:shardA`, `doubt:concurrency`) and gate **every** extra dispatch through `echo '{"ledger":<current>,"key":"<aspect>","max":<escalation.maxSubagentsPerAspect>}' | node "$LIB/route.mjs" spawn` — it returns `ok:false`/`capped` once the aspect hits the cap (3). Thread the returned `ledger` forward through the whole review (reviewers + verifiers share it). Do not blanket-re-review.

## 7. Bounded adversarial verification (code-enforced)
**Run this step only when `plan.runVerify` is true (high/critical tiers).** Lower tiers ship reviewer findings at the ≥80 confidence gate without a refutation pass — that is the deliberate cost trade-off, so don't fabricate a verify pass for them.

Do NOT eyeball this — let the deterministic policy pick the verify set:
```bash
echo '{"findings":[...all collected findings...],"config":<the .review config>,"riskPaths":<signals.riskPaths>}' \
  | node "$LIB/verify.mjs" select
```
It returns `{ select, maxVerifierPasses, maxSubagentsPerAspect }` — only the unsure findings (confidence < `reverify_below`, `uncertain:true`, an unscored finding, or high-severity on a risk path). High-confidence findings off risk paths are not in the set and are kept as-is. **Each selected finding carries flat `lens` + `focus` fields** (security/concurrency/data/resources/perf/error/api/types/observability, else correctness) and, for security findings, a flat `agent` field — pass them to the verifier so the second look attacks from a dimension-appropriate angle, not as another identical refuter.

For each finding in `select`:
- **Gate every dispatch through the spawn ledger** so the per-aspect cap is decided in code, not eyeballed: `echo '{"ledger":<current>,"key":"verify:<file>:<line>","max":<maxSubagentsPerAspect>}' | node "$LIB/route.mjs" spawn` → if it returns `ok:false`/`capped`, stop spawning for that finding; thread the returned `ledger` into the next call.
- Dispatch the verifier named by the finding's flat **`agent` field when it is present AND `plan.discovery.taint` is set (the Tier C data-flow pass — e.g. `taint-verifier` for D3 security findings); otherwise dispatch `finding-verifier`** — with that finding's `lens`/`focus` (adversarial — it tries to REFUTE along the lens). On this **first** verification pass, if `plan.discovery.generativeVerify`, set `generative: true` in the verifier packet so it may surface up to 2 adjacent findings. Take at most `maxVerifierPasses` (≤2) looks and never more than `maxSubagentsPerAspect` (3) agents on that finding. Stop early once two looks agree; for a finding that entered because it was *low-confidence*, take two looks before confirming (a single "real" is not enough).
- Attach the collected verdicts to each finding as `verdicts: [{ verdict, lens }]`, then resolve deterministically:
```bash
echo '{"findings":[{...finding, "verdicts":[...]}, ...],"config":<config>}' | node "$LIB/verify.mjs" resolve
```
It returns `{ report, dropped, needsHuman, summary }`: majority `real` → kept; majority `refuted` → dropped; tie / still-uncertain after the cap → **needs-human** (surfaced, never silently dropped). **A critical/important finding is not dropped on a single refuter** when escalation is enabled and a 2nd look was affordable — resolve routes that lone refutation to needs-human (symmetric burden of proof, highest cost-of-miss); under a starved budget where a 2nd look is impossible, a lone refuter drops it. Use these three lists verbatim.

**Generative verify (Tier C — only if `plan.discovery.generativeVerify`):** collect any `newFindings` the verifiers returned, dedup them against the existing set by `file:line:title`, and run **exactly one** more select→verify pass over just the new ones. On this second pass, dispatch every verifier with **`generative: false`** so it cannot emit further `newFindings` — that single override is what mechanically bounds this to one round (no recursion). It is still ledger-capped. Then re-run resolve over the combined set. Without the flag, ignore `newFindings`.

Only the unsure aspects are re-checked here — the review is never re-run wholesale, and no aspect is looked at more than 3 times total.

## 8. Synthesize
Dispatch **review-synthesizer** with acceptance criteria + mismatches + all findings + verification outcomes + business-logic open questions + memory notes. It returns `{ summary, strengths, criteria, findings, needsHuman, skipped }` (deduped, confidence ≥ 80, traceability per criterion).

## 8b. Completeness sweep — false-negative guard (Tier C — only if `plan.discovery.completenessCritic`)
This is the one pass aimed at what the review MISSED, not at refuting what it found. Skip it entirely unless `plan.discovery.completenessCritic`.
- Dispatch **completeness-critic** with the synthesizer's coverage matrix + kept findings + the skipped-dimension list + `signals.riskPaths` + diff summary + project rules. It returns `{ gaps, assessment }` (≤6 bounded gaps, each with a `dispatch` target).
- For each gap's `dispatch`: gate it through the spawn ledger (`key: "complete:<where>"`) exactly like step 6/7, then run the named agent at just those files. **This is bounded — do NOT loop the critic.** New findings join the pool → run step 7 (verify) on the new ones only → re-run step 8 (synthesize) so the report reflects them.
- Add `assessment` to the report's coverage notes (pass it in `summary`/`skipped` context to step 9).

## 9. Deliver
- If `--comment`: dispatch **pr-comment-author** on the kept findings → comment-ready objects (`fixCode`, `example`, tone).
- Render + gate. Build the payload from the pieces already computed: `findings` = the synthesizer's deduped kept list (== step 7's `report`), `needsHuman` = synthesizer needs-human + business-logic open questions, `context` = the gather bundle (`{pr, tickets, existingComments}` from step 3, so the report cites them), `verify.summary` = step 7's `resolve` summary. Pipe it on stdin:
```bash
echo '{"findings":[...],"criteria":[...],"tier":"<tier>","gate":<gate>,"needsHuman":[...],"skipped":[...],"strengths":[...],"summary":"...","context":{"pr":...,"tickets":[...],"existingComments":[...]},"verify":{"summary":"<resolve summary>"},"learningStore":"<learning.store>","range":"<range>"}' \
  | node "$LIB/report.mjs" [--gate] --out <reportTargets.markdown> --html <reportTargets.html>
```
  - Always writes **REVIEW.md + REVIEW.html** and prints a terminal summary + verdict (`APPROVE`/`WARN`/`BLOCK`). The script also folds in memory (suppresses accepted false-positives, tags recurring) and records this run.
  - `--gate`: the script's exit code is the gate (non-zero on BLOCK) — for hooks/CI.
  - `--comment`: also `echo '{"findings":[enriched],"head":"<head>","prNumber":<n>,"existingComments":[...]}' | node "$LIB/comments.mjs"` to post inline PR comments (deduped against existing). Requires `gh`.
- **Incremental state:** write `.review/last-review.json` with this run's finding keys + range for next-run dedup.
- **Notify:** if `needsHuman` is non-empty and `notify.ask_on_unresolved`, present those open questions to the user in chat as a short numbered list and tell them their answers will be saved to project memory (`.review/learnings.json`) so the same question is not re-asked. Do not block the report on the answer.

## Output discipline
Strengths-first, cite `file:line` for every finding, no performative agreement, advisory only — never edit source.
