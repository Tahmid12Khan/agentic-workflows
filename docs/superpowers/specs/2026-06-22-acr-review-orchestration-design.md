# Design: `/review` thin-orchestrator + Workflow fan-out

**Date:** 2026-06-22
**Status:** Approved (brainstorm) — pending implementation plan
**Component:** `adversarial-code-review` plugin — `/review` orchestration

## 1. Problem

`/review` made repeated, embarrassing mistakes when run in other projects (e.g. `nhst-auth`):

- The report was written to repo-root `REVIEW.md` / `REVIEW.html` instead of the specified per-run folder.
- The HTML report omitted the "Agents & coverage" section (which agents ran / did not run).

### Root cause

`commands/review.md` is a **125-line procedure executed by the LLM main agent**. The main agent must thread ~10 state objects (`WT`, `plan`, `ledger`, `agentRuns`, `trackerUsage`, `worktrees`, `bundle`, `findings`, …) across 9 steps and 20+ subagent dispatches, while also doing every other task. Under context pressure the LLM drops steps and invents defaults. The two failures above are direct violations of the command's own instructions:

| Failure | Command says | Main agent did | Why it was possible |
|---|---|---|---|
| Wrong report path | `review.md:110` — "Do not pass `--out`/`--html`" → per-run folder | passed `--out REVIEW.md` (hallucinated a "default") | `report.mjs:20–21,89–90` *accepts* the override |
| Missing coverage section | `review.md:104` — pass the whole `plan` | omitted `plan` | `report.mjs:54` silently skips the section when `plan` is absent |

Both are **escape hatches the deterministic scripts leave open.** The LLM took them; no error fired.

### Reframe

The desired sub-agent architecture **already exists** in the plugin:

- One responsibility per sub-agent → ~20 dimension reviewers (`vuln-reviewer`, `concurrency-reviewer`, …).
- Independent, unbiased verification → `finding-verifier` / `taint-verifier` refute findings in *separate* agents.
- Shard large/many files → `shard.mjs` + "run each dimension once per shard" (`review.md:60`).

The missing piece is **reliable orchestration**. The fix is to make orchestration deterministic so the LLM cannot deviate, and to push enforcement down into the scripts so wrong output is structurally impossible.

## 2. Goals / Non-goals

**Goals**
- The report is **always** written to the per-run folder in the fixed format — by construction, not by the LLM remembering.
- The HTML/MD report **always** contains the "Ran / Did not run" agent-coverage section — by construction.
- Main agent becomes a thin dispatcher: deterministic bash + one Workflow call. It threads no fragile state and assembles no payloads.
- Fan-out (review) and verification run as a deterministic Workflow with schema-validated sub-agent I/O.
- Every finding is verified by a separate, independent verifier agent (all tiers).
- Large/many files split across more sub-agents (more aspects, never nested agents).

**Non-goals**
- Re-implementing **policy** logic inside the Workflow — `plan.mjs` triage tiers, `verify.mjs select`/`resolve` majority + needs-human routing, `route.mjs scrutiny`/`checks` (single source of truth stays in `lib/*.mjs`, invoked from the main agent or an executor-agent). The only exception is `route.mjs spawn`'s per-aspect *counter* (a trivial `count < max` guard), which is threaded in Workflow JS to avoid an executor-agent per dispatch check — see §4.3.
- Changing the finding contract, severity vocabulary, or dimension set.
- Changing the bounded-verification caps (`≤3 looks` / `≤3 subagents` per aspect).
- Touching reviewed source code (the plugin remains advisory — golden rule #1).

## 3. Architecture

Three layers.

```
MAIN AGENT (thin — deterministic bash + one Workflow call)
  preflight · worktree · plan · gather · scan        [deterministic node, unchanged]
  Workflow({ scriptPath: "$LIB/review-workflow.mjs", args })   ← all subagent fan-out + tail
  relays { folderPath, verdict, needsHuman } to the user
  worktree teardown · incremental state · notify     [deterministic, unchanged]

WORKFLOW (lib/review-workflow.mjs — deterministic JS, schema-validated agents)
  phase Intent    → intent-harvester, intent-grouper, business-logic-analyzer
  phase Review    → pipeline(dimensions × shards)  one agent per aspect → FINDINGS_SCHEMA
  phase Verify    → EVERY finding → its own separate verifier agent → VERDICT_SCHEMA
  [Tier C only]   loop-until-dry · completeness-critic · generative-verify  (gated on plan.discovery.*)
  executor-agent  → runs `verify.mjs resolve`  (deterministic script; single source of truth)
  phase Synthesize→ review-synthesizer agent → deduped findings, criteria, strengths
  (JS) build reportPayload = synthesizer out + counted agentRuns + plan + resolve summary + context
  executor-agent  → runs `report.mjs <payload>` from the MAIN repo → per-run folder
  returns { folderPath, gate, needsHuman, notes }

HARDENED SCRIPTS (lib/*.mjs — enforcement, defense in depth)
  report.mjs: no --out/--html; throws on missing plan/agentRuns
  verify policy: every finding verified (all tiers except trivial)
```

### Why this kills the bug class

- **Control flow is JS, not prose** — the Workflow cannot "forget" to dispatch an agent or drop a field.
- **The report payload is assembled in JS**, not by an attention-degraded LLM. `plan` comes from `args`; `agentRuns` is counted by the Workflow itself; findings/criteria come from the synthesizer's schema'd output. No LLM hand-builds the mega-JSON that failed in nhst-auth.
- **`report.mjs` hard-fails** without `plan`/`agentRuns`, and has no path-override — so even a buggy caller cannot produce a wrong/incomplete report.

## 4. The Workflow (`lib/review-workflow.mjs`)

A Workflow-DSL script (`export const meta` + `agent`/`pipeline`/`parallel`/`phase`/`log`). It is **not** a pipeline-step module — documented as an explicit exception to the `lib/*.mjs` convention in `CLAUDE.md`.

### Inputs (`args`)
Everything deterministic the main agent already computed:
```
{ plan, bundle, diff, shards, flags }
```
- `plan` — verbatim `plan.mjs` output (`tier`, `dimensions`, `dimensionLabels`, `agents`, `dimensionAgents`, `models`, `runVerify`, `verify`, `escalation`, `exhaustive`, `discovery`, `sharded`, `shards`, `scan`, `learning`, `notify`, `trackers`, `mandatoryChecks`, `gate`, `intentSources`, `projectRules`, `signals`, `diffSummary`).
- `bundle` — `gather.mjs` output + MCP-fetched tickets + `trackerUsage`.
- `diff` / `shards` — the diff and per-shard file groups.
- `flags` — `--comment`, `--gate`, `--incremental`, etc.

### Phases

1. **Intent** — `agent(..., {agentType:'intent-harvester', schema})`; then concurrently `intent-grouper` and (standard+ tiers) `business-logic-analyzer`. Business-logic `openQuestions` → carried to `needsHuman`.
2. **Review** — `pipeline(items, review)` where `items = dimensions × shards`. Each item: `agent(packet, {agentType:<dimensionAgent>, model: plan.models[dim], schema: FINDINGS_SCHEMA})`. The reviewer packet is the isolated bundle (`summary + acceptanceCriteria + mismatches + relevant intent groups + project rules + that shard's diff`) — never this chat's history. Extra-intent-scrutiny and mandatory-check routing are computed **in the main agent** (`route.mjs scrutiny` and `route.mjs checks` run alongside `plan`/`gather`) and passed in `args.routing`; the Workflow adds each as an extra review aspect. This keeps `route.mjs` out of the Workflow (no bash in JS).
3. **Verify (every finding)** — `pipeline` stage off Review: each finding → its own verifier agent (`taint-verifier` for D3 security findings when `plan.discovery.taint`, else `finding-verifier`), prompted to **refute** along the finding's `lens`/`focus`. A finding's review can verify while another aspect is still under review (no barrier). The per-aspect cap (`≤3 looks` / `≤3 subagents`) is enforced by **counters threaded in the Workflow's JS state**, keyed by aspect (e.g. `verify:<file>:<line>`): the cap is "stop dispatching for an aspect once its counter hits `plan.verify.maxSubagentsPerAspect`." This re-expresses `route.mjs spawn`'s trivial counter logic in JS rather than paying an executor-agent per dispatch check; `route.mjs spawn` remains for any main-agent-side use. Low-confidence findings take 2 looks before confirming.
4. **Tier C passes** (only when the matching `plan.discovery.*` flag is set):
   - **loop-until-dry** — `while` loop repeating the fan-out up to `plan.discovery.maxRounds`; dedup new findings by `file:line:title`; stop on a dry round.
   - **completeness-critic** — one bounded pass (`≤6` gaps), each gap's `dispatch` runs the named agent at those files, ledger-gated; new findings re-enter Verify then Synthesize.
   - **generative-verify** — verifiers may surface `≤2` adjacent findings on the first pass; exactly one extra select→verify round over the new ones with `generative:false` (bounds recursion).
5. **Resolve** — an **executor sub-agent** runs `verify.mjs resolve` (deterministic policy: majority `real` kept, majority `refuted` dropped, tie/uncertain → `needsHuman`; symmetric burden of proof for critical/important). Stays the script — single source of truth.
6. **Synthesize** — `review-synthesizer` agent → `{ summary, strengths, criteria, findings, needsHuman, skipped }` (deduped, confidence ≥ 80, traceability per criterion).
7. **Build payload + render** — Workflow JS assembles the full `report.mjs` payload (see §6); an **executor sub-agent** runs `report.mjs` from the main repo.

### Schemas (force structured sub-agent output; auto-retry on mismatch)

- `FINDINGS_SCHEMA` — `{ strengths: string[], findings: Finding[] }`, where `Finding = { dimension, severity: "critical"|"important"|"minor"|"suggestion", file, line, title, evidence, fix, confidence: 0..100, uncertain: boolean }` (matches the existing contract in `agents/correctness-reviewer.md:21`).
- `VERDICT_SCHEMA` — `{ verdict: "real"|"refuted"|"uncertain", lens, rationale, confidence, newFindings?: Finding[] }`.
- Intent / synthesizer / completeness-critic keep their existing per-agent JSON shapes (passed through `schema`).

### Sharding

`plan.shards` is computed deterministically by `shard.mjs` in the main agent and passed in `args`. The Workflow expands `dimensions × shards` into pipeline items — **more aspects, not nested agents** (golden rule: no nested agents; concurrency capped at `min(16, cores−2)`). Each shard×dimension is its own aspect with its own `≤3` budget. This is how large/many files scale.

### Error handling (golden rule #3 — degrade, never crash)

- A dying agent → `.filter(Boolean)`, push a human-readable note to `notes[]`, continue.
- Missing MCP tracker / missing `gh` → noted in `notes[]`, not fatal (handled in the main agent's `gather` step and surfaced in `bundle`).
- The Workflow returns partial results + `notes[]`; the report shows them under coverage/skipped.
- Only git remains hard-required (main-agent `preflight.mjs`).

## 5. Script hardening

### `report.mjs`
- **Remove `--out` / `--html`** (delete the arg parsing at lines 20–21 and the override branch at 89–90; update the header comment at line 8). The per-run folder becomes the only behavior. `--base-dir` is retained (relocates the parent only).
- **Throw on missing inputs:** if `data.plan` is absent → exit code 2 with a clear message; if `data.agentRuns` is absent → exit 2. This makes a report without the coverage section impossible.
- Coverage rendering itself is unchanged (`render.mjs:190–201` markdown, `:272–280` HTML already render Ran / Did not run with model, run-count, and reason).

### Verify-all policy
- `plan.runVerify` → true for all tiers except `trivial`.
- The Workflow verifies **every** finding (it iterates the full set in JS); `verify.mjs select`'s filtering is no longer the gate. `select` may be kept for backward-compat / other callers but is not relied on for the new flow.
- `verify.mjs resolve` (majority/needs-human policy) is unchanged.
- Bounded caps unchanged: `≤3` looks and `≤3` subagents per aspect; each finding is its own aspect.

### Cost note
Verify-all means a 50-finding review dispatches 50+ verifier agents. Bounded by the `≤3`-looks cap and the concurrency cap; the report's coverage section shows the real dispatch counts so cost is transparent. This is an explicit, user-approved trade for maximum confidence.

## 6. Data-flow contract

**Main agent → Workflow** (`args`): `{ plan, bundle, diff, shards, flags }` — all deterministic.

**Inside the Workflow**, the report payload is built in JS (no LLM assembly):
```js
const reportPayload = {
  findings,                 // synthesizer kept list (== resolve "report")
  criteria,                 // synthesizer traceability rows (real requirement text + AC# + covered/evidence)
  tier: plan.tier,
  gate: plan.gate,
  needsHuman,               // synthesizer needsHuman + business-logic openQuestions
  skipped,                  // skipped dimensions + notes
  strengths,
  summary,
  context: {                // from bundle
    pr: bundle.pr, tickets: bundle.tickets,
    existingComments: bundle.existingComments, trackerUsage: bundle.trackerUsage,
  },
  plan,                     // verbatim — drives the coverage section
  agentRuns,                // COUNTED by the Workflow across review/verify/extra/Tier-C dispatches
  commentMode: flags.comment === true,
  startedAt, prNumber,      // passed through from args
  worktrees,                // from args (worktree step ran in the main agent)
  learningStore: plan.learning?.store, range: plan.range,
};
```

**Workflow → main agent** (return): `{ folderPath, gate, needsHuman, notes }`. The main agent relays the folder path + verdict, runs worktree teardown, writes incremental state, and presents `needsHuman` — none of which require assembling fragile payloads.

`report.mjs` is run by an **executor sub-agent inside the Workflow**, from the main repo (cwd = project root, so it survives worktree teardown which the main agent does afterward). Rationale for the executor-agent: keep the main agent a pure dispatcher and keep verbose script stdout out of the main context — *not* "fresh attention" (the script is deterministic).

## 7. Main agent command (`commands/review.md` rewrite)

Shrinks from ~125 lines of orchestration to a thin shim:
1. Preflight (`command node "$LIB/preflight.mjs"`).
2. Worktree resolve/setup (`worktree.mjs`) — unchanged; produces `WT`, `worktrees`.
3. Plan / gather / scan (`plan.mjs`, `gather.mjs`, MCP ticket fetch, `scan.mjs`) — unchanged; produces `plan`, `bundle`, `diff`, `shards`.
4. `Workflow({ scriptPath: "$LIB/review-workflow.mjs", args: { plan, bundle, diff, shards, flags } })`.
5. Relay returned `folderPath` + verdict; if `--comment`, the Workflow already dispatched `pr-comment-author` and the main agent runs `comments.mjs` to post (requires `gh`).
6. Worktree teardown, incremental `last-review.json`, notify on `needsHuman`.

All `node` invocations use `command node` (already fixed) to bypass shell `node` shims.

## 8. Guarantees (the two invariants, enforced twice each)

| Invariant | Enforcement 1 (construction) | Enforcement 2 (backstop) |
|---|---|---|
| Report in per-run folder + fixed format | `report.mjs` has no `--out`/`--html` path | only code path is the per-run folder (`report.mjs:92–101`) |
| HTML/MD always shows Ran / Did not run | Workflow always supplies `plan` + counted `agentRuns` | `report.mjs` throws if either is missing |

## 9. Conventions & golden-rules compliance

- **Advisory, never edits source (golden rule #1):** unchanged. Workflow agents are the existing read-only reviewers; only review artifacts under `.adverserial-code-review/` are written.
- **Zero runtime deps (#2):** the Workflow DSL is provided by the harness; `lib/review-workflow.mjs` imports no npm packages.
- **Degrade, never crash (#3):** §4 error handling.
- **Determinism (#4):** no `Date`/random in identity-generating code; the Workflow uses `args`-supplied timestamps (Workflow scripts cannot call `Date.now()`).
- **Module convention:** `lib/review-workflow.mjs` is a documented exception (Workflow-DSL, not a runnable pipeline-step module). Note added to `CLAUDE.md`.
- **Severity vocabulary fixed:** `critical|important|minor|suggestion` — unchanged in `FINDINGS_SCHEMA`.

## 10. Testing

- **Pure helpers** in `lib/review-workflow.mjs` exported and unit-tested (`node --test`): the `dimensions × shards` aspect expansion, the `file:line:title` dedup key, the `reportPayload` builder (given fixture pieces → asserts every required field present), the ledger/cap accounting.
- **`report.mjs` CLI smoke tests** (`tests/cli.test.mjs`): assert it **throws** on missing `plan` and on missing `agentRuns`; assert it ignores/rejects `--out`/`--html`; assert it writes `review.md` + `review.html` into a per-run folder for a valid payload.
- Live sub-agent orchestration is not unit-testable (no network/agents in tests); coverage is via the pure helpers, not live dispatch.

## 11. Docs & migration

- Replace `commands/review.md` in place (delete the 125-line prose flow). Single `/review`.
- Update `README.md` + `docs/ARCHITECTURE.md` via `/sync-docs` in the same change.
- Note the `lib/review-workflow.mjs` module-convention exception in `CLAUDE.md`.
- If an external `acr-review` skill wraps `/review` (not in this repo), it inherits the fix automatically by calling the same command.
- Version bump handled separately via `/release-plugin` (source of truth: `.claude-plugin/plugin.json`, currently `0.2.0`).

## 12. Open risks

- **Workflow ↔ deterministic-script boundary:** the no-FS-in-Workflow constraint means `verify.mjs resolve` and `report.mjs` run via executor sub-agents (which have Bash). Risk: an executor-agent's cwd or environment differs from the main agent's. Mitigation: the executor-agent is given an explicit absolute `$LIB` path and runs from the project root; report path uses `--base-dir` default in the main repo.
- **Cost:** verify-all on large diffs is token-heavy (accepted, transparent via coverage counts).
- **Plugin-shipped Workflow invocation:** confirm a slash command can invoke `Workflow({scriptPath})` against a plugin-bundled file in all install modes (user-scoped, project-scoped). Fallback: command passes the script via `script` read from `$LIB` if `scriptPath` resolution is unreliable.

## 13. Out of scope

- New review dimensions (use `/add-reviewer-dimension`).
- Changes to the verification majority policy or caps.
- The `.zshrc` lazy-nvm fix and the earlier `node` → `command node` change (already done).
