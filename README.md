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
- **Bounded adversarial verify on non-trivial tiers** — on every tier where `plan.runVerify` is true, the **unsure** findings (low-confidence, flagged uncertain, or high-severity on a risk path — via `selectForVerification`) each get their own verification agent; confident, non-risk findings are trusted and ship at the ≥80 gate. Each verifier attacks from a **dimension-appropriate lens** (security→taint, concurrency→interleaving, …) and **escalates cheap→strong**: a first refute on `sonnet`, escalating to `opus` when the cheap verdict is uncertain or refutes a hot finding (`critical`/`important`/`high`), with **critical findings going straight to `opus`** — and on escalation the strong verdict is authoritative (the cheap one is discarded). Confirmed → kept; refuted → dropped; a **hot finding is not dropped on a single refuter** (lone refutation → needs-human when a 2nd look is affordable); a still-split result is surfaced to you, never silently dropped. Cap: **≤ 3 looks and ≤ 3 subagents per aspect**, enforced in code. Models are configurable (`verify.model_first` / `verify.model_escalate` / `verify.escalate_direct_severity`). (Trivial/low tiers skip the verify pass — the cost trade-off.)
- **Exhaustive mode** (`--exhaustive`, auto at `critical`) — opt-in ultrareview-parity passes that trade tokens for fewer misses: a **completeness critic** (what dimension/criterion/taint did we miss?), **generative verify** (a verifier may surface an adjacent finding, not just refute), a **taint/data-flow** verifier for security findings, and **loop-until-dry** re-sweeps. Off by default so normal reviews stay cheap.
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
| `--base <ref>` | Compare against `<ref>` instead of the auto-detected merge-base. |
| `--gate` | Exit non-zero on a `BLOCK` verdict (git hooks / CI). |
| `--comment` | Post confidence ≥ 80 findings as inline PR comments (needs `gh`). |
| `--tier <t>` | Force a tier (`trivial`…`critical`). |
| `--dimensions D2,D3` | Restrict to specific dimensions. |
| `--incremental` | Only re-spend effort on code new since the last review. |
| `--exhaustive` | Force the Tier C ultrareview-parity passes (completeness critic, taint, generative verify, loop-until-dry) at any tier. Costs more tokens; auto-on at `critical`. |
| `--no-checkout` | Review the local working tree in place instead of detaching onto the remote's latest base/head (use for **uncommitted** local changes). |

## The review output

Every run writes a self-contained report. Here is the HTML report for a `high`-tier PR review:

![Example HTML review report](docs/assets/review-example.png)

It opens with the tier + verdict, the PR number and start/finish timestamps, then the
requirement-traceability matrix (each row named, not just `AC1`), the findings grouped by
severity, the **Needs your input** questions, and an **Agents & coverage** rundown of
which agents ran (model + run count) and which did not and why.

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
  input tokens, cache reads, cache writes, output tokens, and USD cost — summed from this
  review's session transcripts (orchestrator + every subagent) within the review window.
  Pricing is overridable via `usage.pricing` in config; set `usage.enabled: false` to hide it.
- **`review.md`** — the same content as Markdown. Renders inline on GitHub/GitLab or in any
  editor; good for diffs, PR descriptions, and grepping.

Both files carry identical findings; pick whichever fits your workflow. The terminal also
prints the folder path, a one-line summary, and the verdict (`APPROVE` / `WARN` / `BLOCK`).

## How it works

```
INTAKE → CONTEXT → TRIAGE → [Workflow: INTENT → REVIEW (fan-out) → VERIFY (unsure findings) → SYNTHESIZE] → REPORT
preflight  gather    plan                harvest/    reviewers         separate agent             rollup       report.mjs
+checkout  +memory                       group/biz   (shard-scoped)    per unsure finding (≤3)                 /gate/comments
+scan
```

`/review` is a **thin dispatcher**: it runs the deterministic scripts (steps 1–3), then hands the fan-out to a Workflow (`lib/review-workflow.mjs`). The main agent never assembles report payloads by hand.

1. **Preflight + checkout** — verify node/git (gh, scanners optional); then, unless `--no-checkout`, `checkout.mjs` fetches the PR's base + head from the remote and **detaches HEAD onto the latest pushed head** — the review reads code and computes the diff there (so the reviewers' own `Read`/`Grep` see the real target), and your original branch is restored afterward (the head/base reviewed is recorded in the report). If the working tree is dirty git would overwrite, the run stops and asks you to stash/commit yourself. If the head is behind its base, it flags the missing commits and asks you to rebase/merge before reviewing.
2. **Context** — `gather.mjs` pulls PR body, **existing comments**, commits, and ClickUp/Jira **issue keys** (the tickets are then fetched **via MCP — no API tokens**); `memory.mjs` loads prior learnings; `scan.mjs` runs dependency CVE scans.
3. **Triage** (`plan.mjs` + `triage.mjs`) — diff → signals → tier, dimensions, per-dim model, **shards**, and the verification/escalation budgets. (The `triage-classifier` judgment pass runs at the start of the Workflow — see below.)
4. **Workflow fan-out** (`lib/review-workflow.mjs`) — the Workflow owns intent → review → verify → synthesize, then returns the assembled report **payload** (it does not render — the sandbox can't write files):
   - **Intent** — `triage-classifier` (haiku, skipped on the trivial tier) first sanity-checks the tier (raises it for the human when blast radius warrants, and **adds dimensions the rules missed** as real review aspects); then `intent-harvester` (stated vs derived + mismatches, **and** primary vs extra intent grouping — the former `intent-grouper`, folded in), `business-logic-analyzer` (assumptions + open questions). Both see the diff with **mechanically-generated noise stripped** (lockfiles, build artifacts, sourcemaps — `stripNoise`, the same set the plan drops from `files`), **diff-first** so the diff prompt-caches across the two calls.
   - **Review** — `correctness-reviewer` always; the planned specialist agents per dimension; one pass per shard for large diffs. Each reviewer gets a **diff scoped to its shard files** plus a **compact intent brief** (criteria + mismatches + the groups flagged for scrutiny) — the shared blocks lead the prompt so they **prompt-cache across every aspect of the same reviewer**. D3/security is the exception: it runs as a **single unsharded pass over the full diff** (so cross-file taint survives, instead of re-paying the whole diff once per shard). Reviewers can Read/Grep for sibling context; extra-intent groups get focused scrutiny.
   - **Verify (the unsure findings)** — on non-trivial tiers (`plan.runVerify` true), the **unsure** findings — low-confidence, flagged uncertain, or high-severity on a risk path (`selectForVerification`) — each get their own verification agent; confident, non-risk findings are trusted and ship at the ≥80 gate. A separate `finding-verifier` (or `taint-verifier` for D3 security) adversarially tries to refute each selected finding — each on a diff **scoped to the finding's own file** (the `taint-verifier` keeps the full diff so cross-file taint survives) to cut input tokens. Cap: **≤ 3 looks and ≤ 3 subagents per aspect**; findings still-split → "needs human". On **exhaustive** reviews, a `completeness-critic` then hunts for what was **missed** (unrun dimension, uncovered criterion, untraced taint) and re-dispatches ≤ 6 targeted reviewers whose new findings re-enter Verify (all of them, for max rigor).
   - **Synthesize** — `review-synthesizer` dedupes, builds the requirement→code matrix, separates findings from open questions, emits a verdict.
5. **Deliver** — the main agent runs `report.mjs` directly on the returned payload (no executor agent), writing `review.md` + `review.html` into a per-run folder `.adverserial-code-review/review-<YYYY-MM-DD>/review-<n>[-pr-<num>]/` + a terminal summary. The report **always** includes an "Agents & coverage" section listing which agents ran and which did not (and why); `report.mjs` takes no `--out`/`--html` flags. Then it relays `folderPath` + verdict + `notes`; `--gate` → exit code; `--comment` → inline comments via `comments.mjs`; records this run to memory; surfaces open questions to you.

### Tiers (the token-saving brain)

| Tier | Example | Review |
|------|---------|--------|
| Trivial | typo, comment, doc | one quick inline pass, no subagents |
| Low | small localized logic w/ tests | one reviewer |
| Standard | normal feature/bugfix | correctness + screens + simplify |
| High | shared lib, API contract, perf hot path | full fan-out + bounded verify |
| Critical | auth, payments, migrations, concurrency, crypto | all dimensions, deepest models, bounded verify |

`risk_map` and `mandatory_checks` in `.adverserial-code-review/config.json` are **floors** triage cannot skip.

### Bounded adversarial verification

Runs on **high/critical tiers** (lower tiers ship at the ≥80 gate). The user-tunable contract: re-check **only the aspects a reviewer was unsure about** — never the whole review — and look at any one aspect **at most 3 times** (1 review + ≤ 2 verifier passes), with **at most 3 subagents** on it; the look-cap is hard-enforced in `verify.mjs` (verdicts are sliced to the budget) and the subagent-cap is decided in code by `route.mjs spawn` (the orchestrator threads the ledger and stops on `ok:false`). Each verifier attacks from a **dimension-appropriate lens** (`verify.mjs select` attaches it; security findings route to a `taint-verifier`). A verifier tries to *refute* the finding; majority rules; a **critical/important finding is not dropped on a single refuter** when escalation is enabled and a 2nd look is affordable (lone refutation → needs-human); any unresolved split is handed to you, not dropped. Configure under `verify` / `escalation`.

## Dimensions & agents

21 bundled agents. The four orchestration agents (`triage-classifier`, `intent-harvester`, `correctness-reviewer`, `review-synthesizer`) plus `business-logic-analyzer`, `finding-verifier`, the two Tier C exhaustive-pass agents (`completeness-critic`, `taint-verifier`), and one specialist per dimension:

| Dim | Agent | Model |
|-----|-------|-------|
| D1/D2/D12 | correctness-reviewer | sonnet |
| D3 security | vuln-reviewer | opus |
| D4 error handling | error-handling-reviewer | sonnet |
| D5 tests | test-adequacy-reviewer | sonnet |
| D6/D8 data & resources | data-store-reviewer | sonnet · opus on migration |
| D7 concurrency | concurrency-reviewer | opus |
| D9 perf | perf-scalability-reviewer | opus |
| D10 API compat | api-compat-reviewer | sonnet |
| D11 types | type-design-reviewer | sonnet |
| D13 docs | docs-comment-reviewer | haiku |
| D14 observability | observability-reviewer | sonnet |
| D15 deps/CVE | dependency-reviewer | sonnet |
| D16 simplification | simplification-reviewer | sonnet |
| D17 a11y/i18n | a11y-i18n-reviewer | sonnet |

Each is isolated (clean packet: intent + criteria + diff, never the chat history), changed-lines-only, and confidence-gated (≥ 80).

## Configuration — `.adverserial-code-review/config.json`

Created by `/review-init`; schema at `.adverserial-code-review/config.schema.json`. Beyond `risk_map`, `mandatory_checks`, `project_rules`, `intent_sources`, and `gate`, v0.2 adds: `verify`, `escalation`, `large_diff`, `scan`, `learning`, `notify`, `checkout` (detach HEAD onto the remote's latest base/head for the review and restore it afterward — so it reviews the most recent pushed code, not the local checkout; the head/base reviewed is recorded in the report), `trackers` (ClickUp/Jira — tickets fetched via MCP, **no API tokens**; if a tracker's MCP server isn't connected, `/review` asks you to enable it and the report states whether each tracker was used), and `usage` (the cost panel — `usage.enabled` to toggle it, `usage.pricing` to override the per-model-family price table).

## Layout

```
commands/   /review, /review-init
agents/     22 bundled agents
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
  build-args.mjs  pre-step outputs (plan/bundle/diff/routing) → Workflow args, file→file (diff never enters agent context)
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
- **Bounded cost** — model tiering + ≤ 3 looks/subagents per aspect.

## Development

```bash
npm test             # or: node --test
```

Runs the unit suite (triage, render, shard, verify, memory, scan, comments, gather, route, checkout) **and** the CLI integration suite (`tests/cli.test.mjs` — spawns plan/verify/scan/report/memory/route/comments/preflight end-to-end). No build, no dependencies.

## Releases & roadmap

- Shipped work, version by version: **[RELEASES.md](RELEASES.md)**.
- What's planned next: **[ROADMAP.md](ROADMAP.md)**.

## License

MIT.
