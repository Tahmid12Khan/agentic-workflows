# Adversarial Code Review

A Claude Code **plugin** for advisory, **criticality-aware** code review. It understands a change's intent, scales review depth to risk (a typo gets a tiny review; an auth/payment/migration change gets adversarial depth), **adversarially verifies the findings it isn't sure about**, learns per project, and delivers results as Markdown, **HTML**, inline PR comments, or a pass/block gate.

**It never modifies your code — strictly advisory.**

> **New here?** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is a diagram-driven walkthrough of how a change flows through the plugin — built for readers who've never seen the code.

## What it does

- **Triages by risk** — deterministic, zero-cost tier selection (trivial → critical); cheap models classify, expensive models review only where the cost-of-miss is high.
- **Reviews the latest pushed code** — fetches the remote's latest base/head and **detaches HEAD onto the head** for the review (restoring your branch afterward), so neither the diff nor the reviewers' own `Read`/`Grep` ever see a stale local checkout; the head/base reviewed is recorded in the report (`--no-checkout` to review the local tree in place; a dirty tree stops the run and asks you to stash/commit yourself). If the head is **behind its base**, it lists the missing commits and asks you to rebase/merge first (advisory — you can proceed) so the diff isn't computed against a stale base.
- **Understands intent both ways** — builds acceptance criteria from the PR, **existing PR comments**, commits, and **ClickUp/Jira** tickets (fetched **via MCP — no API tokens**); derives what the code actually does; flags where the two diverge.
- **Groups changes by intent** — separates the primary intent from **extra/unexplained changes** and scrutinizes the extras (scope-creep control).
- **Reviews every dimension** — 17 dimensions (correctness, security, tests, concurrency, perf, DB/migrations, API-compat, types, deps/CVE, observability, a11y, …), each a dedicated bundled agent, dispatched only when the change warrants it.
- **Runs real tools** — `npm audit` / `pip-audit` feed the dependency dimension.
- **Batched, sonnet-first adversarial verify on non-trivial tiers** — on every tier where `plan.runVerify` is true, the **unsure** findings (low-confidence, flagged uncertain, or high-severity on a risk path — via `selectForVerification`) are **grouped by (verifier lens, file) into at most N batched verifier agents** (per tier: **3** low / **5** standard / **8** high & critical); one agent per group refutes all of its findings in a single pass, **reading only the group's per-file diff slices**, so the diff is paid once (and sliced) per group and agent count stops scaling with finding count. Confident, non-risk findings are trusted and ship at the ≥80 gate. Each group attacks from a **dimension-appropriate lens** (security→taint, concurrency→interleaving, …). **Cost lever — sonnet-first:** a first-pass group runs on the cheap model (`verify.model_first`, default `sonnet`); only a group holding a **critical** finding and the **taint** verifier go straight to `opus`. Then **one extra opus reverify guard** re-checks the refuted/uncertain **hot** findings for false negatives with the bias inverted (a wrongly-dropped real bug is the costly miss, so opus adjudicates every kill) — so **total verifier agents ≤ N+1**. Every selected finding is still verified: the cap bounds **agent count, never coverage**. Confirmed → kept; refuted → dropped; unresolved → surfaced to you, never silently dropped. Configurable: `verify.max_verifier_agents` (or `verify.by_tier.<tier>.max_verifier_agents`), `verify.model_first` (default `sonnet`) and `verify.verify_model` (default `opus`). (Trivial tier skips the verify pass — the cost trade-off.)
- **Optional fan-out trim on content-gated dimensions, off by default (`config.fanout`)** — with `fanout.trim: true`, the specialist dimensions a change's signals add **beyond** its tier's base set can be trimmed: advisory specialists (`fanout.defer_dims`, default perf `D9` + a11y `D17`) are deferred until `fanout.defer_below` (default `high`), and the remaining net-new specialists are capped at `fanout.max_added` (default uncapped), keeping the highest-priority ones (`fanout.keep_order`). **Cost lever — fan-out trim:** this attacks the **agent-count** axis (how many reviewer subagents fan out), alongside sonnet-first verify (model price) and per-file diff slicing (tokens/agent) — but unlike those two it **trades coverage for cost**: a deferred perf/a11y specialist genuinely won't run on a sub-high change (the always-on correctness reviewer still screens those areas), which is why it defaults off. Base-tier dimensions and `always_dims` are never trimmed, and a dropped dimension is always named in the report's **Did not run** section, never a silent cut. The **critical** tier is exempt from trimming altogether — it's the exhaustive tier, where full specialist coverage outweighs the cost saving.
- **Exhaustive mode** (`--exhaustive`, auto at `critical`) — opt-in ultrareview-parity passes that trade tokens for fewer misses: a **completeness critic** (what dimension/criterion did we miss?), a **taint/data-flow** verifier for security findings, and a **double run** of the correctness + vuln reviewers — two independent passes unioned + deduped by finding before verify, so a sample-to-sample miss is caught (real decorrelation, alongside the batched verify + reverify guard). Off by default so normal reviews stay cheap.
- **Cheap false-negative safety net** — near-zero-cost guards against silent misses: an **x1 completeness screen on every workflow tier** (low/standard/high — haiku, coverage-metadata only, no diff) flags dimension/criterion gaps and re-dispatches a per-tier-capped set of **sonnet** reviewers (**low 0** / **standard 1** / **high 2**; critical runs the fuller opus critic instead); a **cross-file consequence check** asks the correctness reviewer whether each in-repo caller of a changed export still holds; a deterministic **bug-history prior** (recent `fix`/`revert` commits touching the changed files, zero model cost) tells intent + correctness which files deserve extra scrutiny; and an opt-in **test-execution signal** (`--run-tests`) feeds real pass/fail to the test reviewer.
- **Scales to large diffs** — shards a big change into coherent review units; no nested-agent sprawl.
- **Remembers** — per-project memory suppresses accepted false-positives, tags recurring findings, and stores open questions so it doesn't re-ask.
- **Asks when unsure** — material business-logic ambiguities become questions for you (saved to memory), not silent assumptions.

## Requirements

| Tool | Required? | Used for |
|------|-----------|----------|
| **Node.js ≥ 18** (20+ recommended) | yes | the pure planning/render/verify scripts (zero npm deps) |
| **git** | yes | computing the diff |
| **a git remote** (e.g. `origin`) | optional | review of the remote's latest base/head (HEAD detached onto it, then restored); without one it reviews the local checkout (`--no-checkout`) |
| **gh** (GitHub CLI) | optional | PR body + existing comments, and `--comment` (inline PR comments) |
| **ClickUp / Atlassian MCP** | optional | pull linked ticket context — **via MCP, no API tokens** |
| **npm / pip-audit** | optional | dependency/CVE scan (D15) |

`/review-init` runs a preflight that checks this and tells you what's missing.

## Install

Self-contained Claude Code plugin **and** a one-plugin marketplace. The repo *is* the
marketplace — add it by its GitHub slug, then install the plugin from it.

```text
/plugin marketplace add Tahmid12Khan/agentic-workflows     # GitHub slug (or a local path)
/plugin install adversarial-code-review@adversarial-code-review     # plugin@marketplace
```

Claude Code clones the repo, reads `.claude-plugin/marketplace.json` (which registers the
`adversarial-code-review` marketplace), and installs the bundled `adversarial-code-review`
plugin. The `/review-init` and `/review` commands are then available.

### Updating

Pull the latest version by refreshing the marketplace — this re-fetches the repo:

```text
/plugin marketplace update adversarial-code-review
```

The installed plugin then picks up the new version. If it doesn't, reinstall it (or manage
everything from the interactive `/plugin` menu):

```text
/plugin install adversarial-code-review@adversarial-code-review
```

## Quickstart

```text
/review-init     # check env + scaffold .adverserial-code-review/config.json
/review          # review the current branch vs its merge-base; writes review.md + review.html into .adverserial-code-review/review-<date>/review-<n>/
```

`/review` flags:

| Flag | Effect |
|------|--------|
| `--pr <n>` | Review PR `#n` directly — resolves its base/head with `gh pr view`, then fetches, detaches onto the head, and reviews the GitHub-exact fork-point range. Pass only this + the repo cwd; the plugin owns the rest (needs `gh`). |
| `--base <ref>` | Compare against `<ref>` instead of the auto-detected base. The reviewed range is always the fork point `merge-base(<ref>,head)..head` (GitHub three-dot) unless `checkout.fork_point:false`. |
| `--gate` | Exit non-zero on a `BLOCK` verdict (git hooks / CI). |
| `--comment` | Post confidence ≥ 80 findings as inline PR comments — a one-click GitHub `suggestion` block when a reviewer gave an exact fix, else a one-line fix description (needs `gh`). |
| `--tier <t>` | Pin the tier (`trivial`…`critical`) **authoritatively** — `risk_map` cannot raise it and `--max-tier` cannot cap it. |
| `--max-tier <t>` | Ceiling on the **auto** tier only: the computed tier is clamped down to `<t>` (never raised, and ignored when `--tier` is set). For budget-capped batch callers. |
| `--dimensions D2,D3` | Restrict to specific dimensions. |
| `--incremental` | Narrow the review to only the commits added since the last review (`prevHead..head`) — but **only on a fast-forward**; a rebase/force-push (or missing state) falls open to the full `base..head`, so rewritten commits are never silently skipped. Off by default. |
| `--full` | Force a complete `base..head` review (opt out of `--incremental`). |
| `--exhaustive` | Force the Tier C ultrareview-parity passes (completeness critic, D3 taint verifier, and a double run of the correctness + vuln reviewers) at any tier. Costs more tokens; auto-on at `critical`. |
| `--run-tests` | Run the configured `tests.command` (never guessed) after checkout and feed pass/fail + failing test **names** to the test-adequacy reviewer and the report header. **Executes repo code — never use on an untrusted PR.** Off by default. |
| `--no-checkout` | Review the local working tree in place instead of detaching onto the remote's latest base/head (use for **uncommitted** local changes). |

## The review output

Every run writes a self-contained report. Here is the HTML report for a `high`-tier PR review:

![Example HTML review report](docs/assets/review-example.png)

It opens with the tier + verdict, the PR number and start/finish timestamps, then the
requirement-traceability matrix (each row named, not just `AC1`), the findings grouped by
severity, an **Out-of-scope observations** section for findings anchored outside the changed
lines (advisory only — never gated or commented), the **Needs your input** questions, and an
**Agents & coverage** rundown of which agents ran (model + run count) and which did not and why.
Only findings on the changed lines drive the verdict/gate; and a `high`/`critical` change that
surfaces **zero** findings is reported as `WARN` ("verify manually"), never a silent `APPROVE`.

### Where reviews are kept

Each run gets its own folder — an outer folder per day, an inner folder per run:

```
.adverserial-code-review/
  review-2026-06-21/                 # outer: the review date (YYYY-MM-DD)
    review-1-pr-128/                  # inner: run counter + PR number
      review.md                      # Markdown report
      review.html                    # same report, self-contained styled HTML
    review-2/                        # no open PR → the -pr-<n> suffix is omitted
      review.md
      review.html
```

The counter resets each day. The base folder (`.adverserial-code-review/`) also holds the
tracked `config.json`; the generated `review-*` folders, `learnings.json`, and
`last-review.json` are git-ignored.

### Format & how to access

- **`review.html`** — a single self-contained file (inline CSS, no assets). Open it in any
  browser: `open .adverserial-code-review/review-*/review-*/review.html` (macOS) or just
  double-click it. Best for reading. Its top-left **usage panel** shows what this run cost —
  input tokens, cache reads, cache writes, output tokens, USD cost, an aggregate **cache-hit%**,
  and a **cost split by scope × model** (orchestrator vs the reviewer fan-out, per model family)
  so you can see what actually dominates spend — summed from this review's session transcripts
  (the orchestrator transcript plus the whole `subagents/` subtree, including Workflow reviewer
  transcripts nested under `subagents/workflows/wf_*/`) within the review window. Pricing is
  overridable via `usage.pricing` in config; set `usage.enabled: false` to hide it.
- **`review.md`** — the same content as Markdown, now including a **Cost** section mirroring the
  panel (total, cache-hit%, and the scope×model breakdown). Renders inline on GitHub/GitLab or in
  any editor; good for diffs, PR descriptions, and grepping.

Both files carry identical findings; pick whichever fits your workflow. The terminal also
prints the folder path, a one-line summary, and the verdict (`APPROVE` / `WARN` / `BLOCK`).

## How it works

```
INTAKE → CONTEXT → TRIAGE → [Workflow: INTENT → REVIEW (fan-out) → VERIFY (batched) → SYNTHESIZE] → REPORT
preflight  gather    plan                harvest/    reviewers        ≤N sonnet-first groups     rollup       report.mjs
+checkout  +memory                       group/biz   (diff sliced)     + 1 opus reverify guard                /gate/comments
+scan
```

`/review` is a **thin dispatcher**: it runs the deterministic scripts (steps 1–3), then hands the fan-out to a Workflow (`lib/review-workflow.mjs`). The main agent never assembles report payloads by hand.

1. **Preflight + checkout** — verify node/git (gh, scanners optional); then, unless `--no-checkout`, `checkout.mjs` fetches the PR's base + head from the remote and **detaches HEAD onto the latest pushed head** — the review reads code and computes the diff there (so the reviewers' own `Read`/`Grep` see the real target), and your original branch is restored afterward (the head/base reviewed is recorded in the report). If the working tree is dirty git would overwrite, the run stops and asks you to stash/commit yourself. If the head is behind its base, it flags the missing commits and asks you to rebase/merge before reviewing.
2. **Context** — `gather.mjs` pulls PR body, **existing comments**, commits, and ClickUp/Jira **issue keys** (the tickets are then fetched **via MCP — no API tokens**); `memory.mjs` loads prior learnings; `scan.mjs` runs dependency CVE scans.
3. **Triage** (`plan.mjs` + `triage.mjs`) — diff → signals → tier, dimensions, per-dim model, **shards**, and the verification budget (per-tier `maxVerifierAgents` + `verifyModel`). (The `triage-classifier` judgment pass runs at the start of the Workflow — see below.)
4. **Workflow fan-out** (`lib/review-workflow.mjs`) — the Workflow owns intent → review → verify → synthesize, then returns the assembled report **payload** (it does not render — the sandbox can't write files):
   - **Intent** — `triage-classifier` (haiku, skipped on the trivial tier) first sanity-checks the tier (raises it for the human when blast radius warrants, and **adds dimensions the rules missed** as real review aspects); then a single `intent-analyzer` pass (the former `intent-harvester` + `business-logic-analyzer`, merged) builds the acceptance-criteria model (stated vs derived + mismatches), the primary-vs-extra intent grouping, **and** the domain/business-logic model (assumptions + open questions) — reasoning in **stages** (criteria/groups before assumptions/questions) so the merge keeps the old producer→consumer barrier. It **`Read`s the diff from `args.diffPath`**, told to ignore mechanically-generated churn (lockfiles, build artifacts, sourcemaps), plus the deterministic **bug-history prior** (`history.mjs`: recent `fix`/`revert` commits touching the changed files). Runs at **low+** so even low-tier reviewers get an intent brief.
   - **Review** — `correctness-reviewer` always; the planned specialist agents per dimension; one pass per shard for large diffs. **Args-by-reference + per-file slicing (cost lever):** `build-args.mjs` writes a per-file diff slice for each changed file, so each reviewer **`Read`s only its files' slices** (`diffReadFor`) instead of the whole diff, falling back to the full `args.diffPath` when a slice is missing (D3/security keeps the full diff for cross-file taint); it also gets a **compact intent brief** (criteria + mismatches + the groups flagged for scrutiny), and a **shared context pack** (`context-pack.mjs`, built once in step 3: the enclosing definitions of changed code, import blocks, and in-repo callers of changed exports — passed by path in `args.contextPackPath`, `Read` first) — the shared blocks lead the prompt so they **prompt-cache across every aspect of the same reviewer** (caching is **intra-agent only** — distinct agents have distinct system prompts, so nothing caches across the intent/review/verify boundary; the report's **cache-hit% panel** shows the real per-run rate). Reviewers **use the pack first** and make at most ~4 extra Read/Grep calls, only when it's insufficient for a specific suspected finding (no `Bash`). D3/security is the exception: it runs as a **single unsharded pass over the full diff** (so cross-file taint survives, instead of re-paying the whole diff once per shard). Extra-intent groups get focused scrutiny. Per-reviewer extras ride the packet: the **correctness reviewer** gets a **cross-file consequence** directive (does each listed caller still hold?) plus the **bug-history prior**; the **test-adequacy reviewer** gets the **executed-test signal** when `--run-tests` ran.
   - **Verify (batched, sonnet-first)** — on non-trivial tiers (`plan.runVerify` true), the **unsure** findings — low-confidence, flagged uncertain, or high-severity on a risk path (`selectForVerification`) — are **grouped by (verifier lens, file) into ≤ `maxVerifierAgents` groups** (per tier: 3/5/8) and refuted a group at a time: one `finding-verifier` (or `taint-verifier` for D3 security) per group returns a verdict for every finding it holds — each **`Read`s only the group's per-file diff slices** (`diffReadFor`; the `taint-verifier` keeps the full diff so cross-file taint survives). **Cost lever — sonnet-first:** a first-pass group runs on the cheap model (`verify.model_first`, default `sonnet`); only a group holding a **critical** finding and the taint verifier go straight to `opus`. Confident, non-risk findings are trusted and ship at the ≥80 gate. Then **one extra opus reverify guard** re-examines the refuted/uncertain hot findings for false negatives (bias inverted — uphold unless the refutation clearly holds, so opus adjudicates every kill), so **total verifier agents ≤ N+1**. Every selected finding is verified — the cap bounds agent count, not coverage; an unresolved finding → "needs human". On **every workflow tier** (low/standard/high) a cheap **x1 completeness screen** (haiku, coverage-metadata only — no diff, so dimension/criterion gaps, not taint) reuses `completeness-critic` and re-dispatches a per-tier-capped set of **sonnet** reviewers (**low 0** / **standard 1** / **high 2**). On **exhaustive** reviews (critical/`--exhaustive`) the full `completeness-critic` (opus, with the diff) instead hunts for what was **missed** (unrun dimension, uncovered criterion, untraced taint) and re-dispatches ≤ 6 targeted reviewers. Either way the new findings re-enter the batched Verify.
   - **Synthesize** — `review-synthesizer` dedupes, builds the requirement→code matrix, separates findings from open questions, emits a verdict.
5. **Deliver** — the main agent runs `report.mjs` directly on the returned payload (no executor agent), writing `review.md` + `review.html` into a per-run folder `.adverserial-code-review/review-<YYYY-MM-DD>/review-<n>[-pr-<num>]/` + a terminal summary. The report **always** includes an "Agents & coverage" section listing which agents ran and which did not (and why); `report.mjs` takes no `--out`/`--html` flags. Then it relays `folderPath` + verdict + `notes`; `--gate` → exit code; `--comment` → inline comments via `comments.mjs`; records this run to memory; surfaces open questions to you.

### Tiers (the token-saving brain)

| Tier | Example | Review |
|------|---------|--------|
| Trivial | typo, comment, doc | one quick inline pass, no subagents |
| Low | small localized logic w/ tests | one reviewer + x1 haiku completeness screen (0 gap re-dispatch) |
| Standard | normal feature/bugfix | correctness + screens + x1 haiku completeness screen (≤1 gap) |
| High | shared lib, API contract, perf hot path | full fan-out + simplify + bounded verify + x1 haiku completeness screen (≤2 gaps) |
| Critical | auth, payments, migrations, concurrency, crypto | all dimensions, deepest models, bounded verify |

`risk_map` and `mandatory_checks` in `.adverserial-code-review/config.json` are **floors** triage cannot skip. `review_instructions` (default `REVIEW.md`) is a **mandate**: its content is injected verbatim as the highest-priority block leading the reviewers, intent-analyzer, and completeness-critic — review-specific guidance that outranks the general `project_rules` conventions.

### Bounded adversarial verification

Runs on **every non-trivial tier** (`plan.runVerify`), with findings shipping at the ≥80 gate by default. The contract: re-check **only the findings a reviewer was unsure about** — never the whole review — and do it in **at most N+1 agents per run**. The selected (unsure) findings are **grouped by (verifier lens, file) into ≤ N batched verifier agents** — one **opus** agent per group refutes every finding it holds in a single pass (the diff is paid once per group), and **N is a per-tier budget** (`maxVerifierAgents`, default **3** low / **5** standard / **8** high & critical). Every selected finding lands in exactly one group, so the cap bounds **agent count, never coverage**. Then a single **+1 opus reverify guard** re-examines the refuted/uncertain **hot** findings for false negatives (bias inverted — uphold unless the refutation clearly holds on the changed lines), because a wrongly-dropped real bug is the costly miss. Each group attacks from a **dimension-appropriate lens** (`verify.mjs select` attaches it; security findings route to a `taint-verifier` that keeps the full diff for cross-file source→sink). A verifier tries to *refute*; confirmed → kept, refuted → dropped, any unresolved split → handed to you, not dropped. Configure under `verify`: `max_verifier_agents` (or `by_tier.<tier>.max_verifier_agents`), `verify_model` (default `opus`). The confidence bar is **80/80 on every tier by default** (worst-case rigor is never lowered for you); a project can spend a **per-tier verify budget** via `verify.by_tier.<tier>` — trust findings at a lower confidence on a lower-risk tier to select fewer for verification. `reverify_below` is clamped up to `report_confidence` per tier, so a per-tier relaxation lowers both together and never opens a dead band.

## Dimensions & agents

20 bundled agents. The four orchestration agents (`triage-classifier`, `intent-analyzer`, `correctness-reviewer`, `review-synthesizer`) plus `finding-verifier`, the two Tier C exhaustive-pass agents (`completeness-critic`, `taint-verifier`), and one specialist per dimension:

| Dim | Agent | Model |
|-----|-------|-------|
| D1/D2/D12 | correctness-reviewer | sonnet |
| D3 security | vuln-reviewer | opus at high/critical · sonnet below |
| D4 error handling | error-handling-reviewer | sonnet |
| D5 tests | test-adequacy-reviewer | sonnet |
| D6/D8 data & resources | data-store-reviewer | sonnet · opus on migration |
| D7 concurrency | concurrency-reviewer | opus at high/critical · sonnet below |
| D9 perf | perf-scalability-reviewer | opus at high/critical · sonnet below |
| D10 API compat | api-compat-reviewer | sonnet |
| D11 types | type-design-reviewer | sonnet |
| D13 docs | docs-comment-reviewer | haiku |
| D14 observability | observability-reviewer | sonnet |
| D15 deps/CVE | dependency-reviewer | sonnet |
| D16 simplification | simplification-reviewer | sonnet · high+ only (opt-in below via `always_dims`/`--dimensions`) |
| D17 a11y/i18n | a11y-i18n-reviewer | sonnet |

Each is isolated (clean packet: intent + criteria + diff, never the chat history), changed-lines-only, and confidence-gated (≥ 80).

## Configuration — `.adverserial-code-review/config.json`

Created by `/review-init`; schema at `.adverserial-code-review/config.schema.json`. Beyond `risk_map`, `mandatory_checks`, `project_rules` (paths to general repo conventions, surfaced as context), `review_instructions` (path to a review-specific mandate — default `REVIEW.md` — whose **content** leads the reviewers/intent/critic prompts at highest priority; capped at 8k, disabled by dropping the key or the file), `intent_sources`, and `gate`, v0.2 adds: `always_dims` (dimensions reviewed on every run regardless of tier — e.g. `D16`), `models` (per-dimension model matrix — `opus_dims`, `opus_min_tier`, `by_tier`), `verify` (the batched-verify policy — `max_verifier_agents` and `by_tier.<tier>.max_verifier_agents` per-tier agent budget, `verify_model` default `opus`, plus the `reverify_below`/`report_confidence` bars), `fanout` (the agent-count cost lever, off by default — `fanout.trim` to enable; defers `fanout.defer_dims` (default `D9`/`D17`) below `fanout.defer_below` (default `high`), and caps net-new content-gated specialists at `fanout.max_added` (default uncapped), ranked by `fanout.keep_order`), `large_diff`, `scan`, `learning`, `notify`, `checkout` (detach HEAD onto the remote's latest base/head for the review and restore it afterward — so it reviews the most recent pushed code, not the local checkout; the head/base reviewed is recorded in the report), `trackers` (ClickUp/Jira — tickets fetched via MCP, **no API tokens**; if a tracker's MCP server isn't connected, `/review` asks you to enable it and the report states whether each tracker was used), `usage` (the cost panel — `usage.enabled` to toggle it, `usage.pricing` to override the per-model-family price table), `tests` (`tests.command` + `tests.timeout_ms` — the test command `--run-tests` runs; never guessed), and `completeness` (`completeness.screen_on_high` — toggle the cheap high-tier completeness screen, default on).

## Layout

```
commands/   /review, /review-init
agents/     20 bundled agents
lib/
  preflight.mjs   env check
  plan.mjs        diff → review plan (tier, dims, shards, budgets)
  triage.mjs      signals + config → plan (pure)
  signals.mjs     diff metadata → signals (pure)
  shard.mjs       large diff → review shards (pure)
  verify.mjs      bounded adversarial policy — select/resolve CLI + pure
  route.mjs       deterministic routing — extra-intent scrutiny, forced checks, aspect-budget ledger
  memory.mjs      per-project learnings store
  gather.mjs      PR / comments / trackers (keys) / rules → context bundle
  build-args.mjs  pre-step outputs (plan/bundle/diff/context/routing) → Workflow args, file→file (diff + pack never enter agent context)
  context-pack.mjs shared context pack — enclosing defs of changed code, imports, in-repo callers (CLI + pure)
  history.mjs     bug-history prior — recent fix/revert commits per changed file (CLI + pure)
  test-signal.mjs --run-tests: run the configured test command → pass/fail + failing names (CLI + pure)
  checkout.mjs    latest-code review: fetch remote base/head, detach HEAD onto head, restore after
  scan.mjs        npm/pip dependency CVE scan
  render.mjs      findings → review.md + review.html + verdict (pure)
  usage.mjs       this run's token usage + USD cost from the session transcripts (CLI + lib)
  report.mjs      render + gate + memory record (CLI)
  review-workflow.mjs     Workflow DSL — fan-out (intent/review/verify/synthesize); returns the report payload
  review-orchestration.mjs  pure helpers for the Workflow (canonical + unit-tested)
  trim-diff.mjs   scope a diff to a reviewer's shard files (pure, canonical for the inlined copy)
  comments.mjs    inline PR comments via gh (CLI)
.adverserial-code-review/    config.schema.json, config.json (dogfood)
tests/      node:test unit tests
fixtures/   sample diffs + expected tiers
```

## Design principles

- **Portable, zero-dependency** — pure ESM `.mjs`, only Node + git required.
- **Reviewer isolation** — each agent gets a clean packet, never the chat history. *(Enforced by the orchestrator command's packet construction, not a `lib/` backstop — agent-instructed.)*
- **False-positive control** — confidence ≥ 80; adversarial verify with per-dimension lenses (security/error/data/concurrency/resources/perf/api/types/observability; generic correctness fallback for the rest); accepted-FP memory.
- **Doubt is surfaced, not hidden** — unresolved findings (and lone refutations of high-severity findings) go to a "needs human" list.
- **Changed lines only** — pre-existing issues outside the diff are not flagged. *(Agent-instructed; no taint-following across the diff boundary.)*
- **Bounded cost** — model tiering + a per-tier verifier-agent budget (≤ N+1 batched verifier agents per run).

## Limits

What this plugin deliberately does **not** do — so you know where to keep other gates:

- **No dynamic analysis** beyond the opt-in `--run-tests` pass (it runs the configured `tests.command`, nothing else). No fuzzing, profiling, coverage measurement, or sanitizers.
- **No design/architecture judgment beyond the diff.** Reviewers reason about the changed lines plus the context pack (enclosing definitions, imports, in-repo callers); they do not evaluate whole-system design, module boundaries, or whether the feature should exist.
- **No cross-repo contract analysis.** It cannot see consumers in other repositories. For the multi-consumer / breaking-change problem, keep dedicated CI contract gates — e.g. [oasdiff](https://github.com/oasdiff/oasdiff) or [buf](https://buf.build) for API/proto compatibility, [Pact](https://pact.io) for consumer-driven contracts.
- **No debate between reviewers.** Each dimension reviewer runs in isolation; verification is adversarial refutation of findings (batched by lens+file), not a multi-agent argument. Exhaustive mode adds a second independent reviewer pass (double run), not a debate.
- **Advisory only.** It never edits, commits, or applies a fix — every finding's `fix`/`fixCode` is rendered as a suggestion for you (or a one-click GitHub `suggestion` block) to accept.

## Development

```bash
npm test             # or: node --test
```

Runs the unit suite (triage, render, shard, verify, memory, scan, comments, gather, route, checkout, context-pack, history, test-signal) **and** the CLI integration suite (`tests/cli.test.mjs` — spawns plan/verify/scan/report/memory/route/comments/preflight/context-pack/history/test-signal end-to-end). No build, no dependencies.

## Releases & roadmap

- Shipped work, version by version: **[RELEASES.md](RELEASES.md)**.
- What's planned next: **[ROADMAP.md](ROADMAP.md)**.

## License

MIT.
