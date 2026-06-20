# Systematic Code Review System — Design Spec

**Date:** 2026-06-07
**Status:** Approved direction; pending spec review → implementation plan
**Repo:** `agentic-workflows` (greenfield)

## Problem

We want an automated, senior-engineer-grade code review that:
1. Understands a change's **intent** (PR body, commits, ClickUp/Jira issue + comments, project rules) without over-reading.
2. Builds a **mental model of acceptance criteria / expected test cases**.
3. Verifies the change: correctness, optimization, bugs, project-rule and framework best-practice compliance, security/vulns, scalability, and that changes are covered by passing tests.
4. **Scales review depth to change criticality** — a text change gets a tiny review; a critical-path change gets adversarial, in-depth review — to save tokens and avoid over-review.
5. Is **generic** (any stack) with **language/framework packs** for depth, plus a **human-defined checklist** floor for the worst case.

Constraint chosen by owner: the system is **strictly advisory** — it never modifies code. It reports, comments, and gates (verdict/exit-code) only.

## Key finding from asset audit

Most parts already exist in `~/.claude` but are **duplicated and uncoordinated**. The work is consolidation + orchestration, not greenfield agent sprawl.

Duplication to resolve:
- **3 `code-reviewer`s**: `~/.claude/agents/code-reviewer.md` (sonnet; generic + React + Node), `pr-review-toolkit/agents/code-reviewer.md` (opus; CLAUDE.md compliance + confidence≥80 filter), `superpowers/.../agents/code-reviewer.md` (inherit; plan-alignment). → **collapse to one** `correctness-reviewer`, keeping: confidence≥80 false-positive filter (pr-review-toolkit), plan/intent alignment + strengths-first (superpowers), full-file+imports read & CLAUDE.md check (personal).
- **2 `code-simplifier`s** (pr-review-toolkit + code-simplifier plugin). → **one**, advisory-only.
- **Security** duplicated across `security-reviewer` agent + `security-review` skill (same OWASP content). → skill becomes a **knowledge pack**; agent is the executor.
- **N+1** detection in 5 agents; **SQL-injection / hardcoded-secrets** in 6. → define once in the shared catalog; packs specialize.
- **Java** rules scattered across `java-reviewer` + `java-code-review` + `java-coding-standards` + `jpa-patterns` + 2 test generators. → reviewer **loads** these packs; does not restate them.

## Architecture — 8-phase pipeline

```
INTAKE → INTENT → CRITERIA → [TRIAGE] → REVIEW(fan-out) → VERIFY → SYNTH+GATE → DELIVER → (re-review loop)
 haiku    h/son    sonnet     sonnet     sonnet/opus      opus      sonnet       gh/file/exit
```

| Phase | Purpose | Model |
|------|---------|-------|
| 0 Intake & Eligibility | resolve `BASE..HEAD` SHAs; skip draft/closed/automated/already-reviewed PRs; **stop if build red or merge conflict** (typescript-reviewer pattern) | haiku |
| 1 Intent Harvest | pull PR body + commits + ClickUp + Jira + project-rules files; **depth-capped by tier preview** | haiku→sonnet |
| 2 Acceptance-Criteria Model | derive expected behaviors + the test matrix the change should satisfy | sonnet |
| 3 Criticality Triage | classify blast radius → review plan {dimensions, depth, models} | sonnet |
| 4 Review (fan-out) | run selected dimension agents in parallel; packs loaded on demand | sonnet/opus |
| 5 Adversarial Verify | High/Critical only: multi-vote refutation per finding; kill false positives | opus |
| 6 Synthesize & Gate | dedupe, severity rollup, requirement→code traceability matrix, verdict | sonnet (opus for Critical PR) |
| 7 Deliver | inline PR comments + REVIEW.md + terminal + exit-code gate | — |
| 8 Incremental re-review | on new commits: review only new SHAs, reuse cached verdicts | — |

Rationale: intent before code (reviewer knows what "correct" means); triage before fan-out (spend matches risk); verify after review (only real findings reach humans); synth before deliver (one ranked verdict, not N dumps).

## Criticality triage (the token brain)

**Signals (cheap, no deep reading):** files-changed count, net LOC, hunks; **paths** matched against a risk map (`auth/`, `payment/`, `*migration*`, `crypto`, `infra/`, `Dockerfile`, `*.tf`, `config/secrets`); public-contract surface (controllers, `*.proto`, OpenAPI, exported types, published packages); dependency manifest changed; tests present?; concurrency primitives touched; blast radius (one `grep` of importers); languages detected (→ which packs); **config/secret files** (`.env*`, `*.pem`, `*.key`, `application.yml`) → force security path; **deletion:addition ratio** (high deletions → possible breaking-removal / dead code, cross-check public-contract); **scope-drift** (changed paths outside stated intent bump the tier).

> Token-efficiency note: generated/lockfile noise (`dist/`, `*.lock`, `*.min.js`, `*.pb.go`, snapshots) is **excluded from LOC counting** so it never inflates the tier.

| Tier | Examples | Dimensions | Depth | Models |
|------|----------|-----------|-------|--------|
| **Trivial** | typo, comment, README, copy | correctness sanity + comment accuracy | single pass | haiku |
| **Low** | small localized logic w/ tests | correctness + tests + simplify(advisory) | 3 agents parallel, single-vote | sonnet (+haiku) |
| **Standard** | normal feature/bugfix | correctness, tests, security-screen, best-practices, simplify | 4–5 agents parallel | sonnet; opus if a finding looks Critical |
| **High** | shared lib, API contract, perf hot path | + API-compat, perf/scalability, data-access, type-design | full fan-out + **verify** | sonnet review, **opus verify** |
| **Critical** | auth, payments, migrations, concurrency, crypto, infra | **all**; mandatory security + migration-safety + idempotency + concurrency | full fan-out + **3-vote verify** + architect pass | **opus** on hot dimensions |

Dimensions are also **content-gated**: no types → skip type-design; no error handling → skip silent-failure-hunter; etc. (pr-review-toolkit conditional dispatch).

## Canonical review-dimension catalog (deduped)

| # | Dimension | Backing asset (reuse) | Mandatory when | Model |
|---|-----------|-----------------------|----------------|-------|
| D1 | Intent & traceability (criteria coverage + scope-creep/drift) | gstack/review scope-drift | always | sonnet |
| D2 | Correctness & quality (bugs, null/race, dead code, AI-regression) | merged `correctness-reviewer` (3→1) | always | sonnet (opus if Critical) |
| D3 | Security & vulns (OWASP, secrets, injection, SSRF, IDOR, crypto, deser) | `security-review` skill + `security-reviewer` | auth/input/API/payment/deps | opus |
| D4 | Error handling (silent failure, broad catch, leaked detail) | `silent-failure-hunter` | error handling in diff | sonnet |
| D5 | Test adequacy (behavioral coverage, edge/error branches, flaky, brittle) | `pr-test-analyzer` + tdd-workflow + java test gens | always (gate) | sonnet |
| D6 | Data & DB (N+1, indexes, tx scope, migration safety/reversibility, pagination, RLS) | `database-reviewer` + `jpa-patterns` | DB/migration/query in diff | opus for migration, else sonnet |
| D7 | Concurrency & async (bounded pools, no blocking on event loop, race/deadlock, idempotency/retry+jitter) | catalog (new) | concurrency primitives touched | opus |
| D8 | Connections & resources (pool sizing/leak/timeout, keep-alive, closeable lifecycle) | jpa-patterns (Hikari) + catalog | DB/HTTP-client/stream in diff | sonnet |
| D9 | Scalability & perf (complexity, caching+invalidation, backpressure, rate limit) | backend-patterns + catalog | perf hot path / large data | opus |
| D10 | API contract & compat (breaking change, versioning, consumer impact) | api-design | public API/schema/event change | sonnet |
| D11 | Type design (invariants, encapsulation, illegal states unrepresentable) | `type-design-analyzer` | new/modified types | sonnet |
| D12 | Project-rules compliance (CLAUDE.md/AGENTS.md/standards) | code-review plugin + standards skills | always | haiku→sonnet |
| D13 | Docs & comment accuracy (rot, stale README/ADR, doc sync) | `comment-analyzer` + java-code-review doc-sync | comments/docs/public API touched | haiku |
| D14 | Observability of the change (new failure modes instrumented; no PII in logs) | catalog (new) | new external calls / failure modes | sonnet |
| D15 | Dependency & supply chain (CVE, license, pinning, typosquat) | catalog (new) + `npm audit`/`pip-audit`/`mvn` | dependency manifest changed | sonnet |
| D16 | Simplification (advisory suggestions only — never edits) | merged `code-simplifier` (2→1) | Standard+ | haiku/sonnet |
| D17 | A11y & i18n (aria, contrast, externalized strings, RTL, keyboard) | catalog (new) | UI/template change | sonnet |

**Language specialization = packs, not agents.** Dimension reviewers load the matching skill only when relevant file types appear:
- Java → `java-coding-standards`, `jpa-patterns`, `java-unit-test-generator`, `java-integration-test-generator`
- Python → `python-reviewer` rules
- TS/JS → `typescript-reviewer`, `coding-standards`
- SQL/migration → `database-reviewer`, `jpa-patterns`
- none matched → generic catalog only

## Build vs reuse vs delete

- **BUILD (new):** 1 orchestrator workflow; `/review` + `/review-config` commands; 3 thin agents — `triage-classifier`, `intent-harvester`, `finding-verifier`; `review-config` skill (human checklist); 4 hooks. New thin dimension agents: `concurrency-reviewer`, `perf-scalability-reviewer`, `api-compat-reviewer`, `dependency-reviewer` (each mostly loads a pack + catalog checks).
- **MERGE:** 3 code-reviewers → 1 `correctness-reviewer`; 2 simplifiers → 1.
- **REUSE as agent:** `silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`, `comment-analyzer`, `security-reviewer`, `database-reviewer`, `java-reviewer`.
- **REUSE as knowledge-pack (load on demand):** `security-review`, `java-coding-standards`, `jpa-patterns`, `api-design`, `backend-patterns`, `coding-standards`, `tdd-workflow`, `e2e-testing`, `java-*-test-generator`.
- **REUSE pattern (steal, don't keep file):** gstack/review scope-drift + Codex second-opinion; code-review plugin parallel-Sonnet + Haiku-confidence-scoring.
- **DELETE/RETIRE:** redundant copies after merge; do **not** build per-language full pipelines (packs replace them).

## Agents (final set + models)

| Agent | Role | Model | Why |
|-------|------|-------|-----|
| `triage-classifier` | signals → tier + plan | haiku | mechanical classification |
| `intent-harvester` | PR/commits/ClickUp/Jira/rules → acceptance criteria (depth-capped) | sonnet | judgment to summarize shallowly |
| `correctness-reviewer` (merged) | D1/D2/D12 | sonnet (opus if Critical) | standard review |
| `security-reviewer` (reuse) | D3 | opus | high cost-of-miss |
| `silent-failure-hunter` (reuse) | D4 | sonnet | scoped hunt |
| `pr-test-analyzer` (reuse) | D5 | sonnet | coverage judgment |
| `database-reviewer` (reuse) | D6/D8 | opus for migrations, else sonnet | irreversible risk |
| `concurrency-reviewer` (new) | D7 | opus | hardest to get right |
| `perf-scalability-reviewer` (new) | D9 | opus on hot path | architectural |
| `api-compat-reviewer` (new) | D10 | sonnet | rule-based |
| `type-design-analyzer` (reuse) | D11 | sonnet | |
| `comment-analyzer` (reuse) | D13 | haiku | mechanical |
| `dependency-reviewer` (new) | D15 + scan tools | sonnet | |
| `finding-verifier` (new) | adversarial multi-vote; trust gate | opus | refute weak findings |
| `code-simplifier` (merged, advisory) | D16 | haiku/sonnet | suggestions only |
| `review-synthesizer` | rollup, traceability, verdict | sonnet (opus Critical) | |

"Thin" agents are short files that load the relevant pack + catalog checks; no restated checklists.

## Orchestrator (workflow)

A deterministic Workflow script (not a mega-agent), because triage → conditional fan-out → verify → gate is loop/branch logic. Verify uses the **pipeline pattern** (each dimension's findings verify as soon as that dimension finishes — no barrier). Trivial/Low skip Verify. Each dimension agent receives an **isolated context packet** (intent + acceptance criteria + `BASE_SHA..HEAD_SHA` diff), never raw session history (superpowers isolation rule).

## Hooks (local + pre-push + CI)

| Hook | Event | Action |
|------|-------|--------|
| pre-push (git) | `pre-push` | `/review --gate` on `@{push}..HEAD`; **block** on Critical (`--no-verify` overrides) |
| PR CI (GitHub Action) | PR open/sync | headless review → inline comments + REVIEW.md artifact + **fail check** on Critical/High |
| SessionStart (Claude Code) | startup | load `review-config` (risk-map + human checklist) into context |
| PostToolUse/Stop (optional) | after edits | nudge "run /review before push" if diff touches risk-map paths |

Hooks never modify code (advisory constraint); they gate only.

## Commands

| Command | Purpose |
|---------|---------|
| `/review` | main entry. Flags: `--tier auto\|trivial..critical`, `--comment` (post inline), `--gate` (exit code), `--base <ref>`, `--dimensions <list>`. No `--fix` (advisory-only). |
| `/review-config` | scaffold/edit per-project risk-map + human checklist |
| existing `/code-review`, `/python-review`, `/java-code-review` | demoted to manual single-dimension shortcuts |

## Delivery (all four sinks, one synthesis)

- **Inline PR comments** — line-anchored via `gh` API, full-SHA permalinks, threaded replies; only findings with **confidence ≥ 80**.
- **REVIEW.md** — severity-grouped + **traceability matrix** (criterion → covered? → evidence file:line) + strengths-first summary.
- **Terminal** — compact tiered summary.
- **Gate/verdict** — `APPROVE / WARN / BLOCK` + exit code (Block on Critical; High configurable). No code mutation.

## Additional review concerns (beyond the original ask)

**Engineering depth:** bounded thread pools / no blocking on event loops / race-deadlock / lock ordering (D7); connection pool min/max explicitly sized + acquisition timeout + leak-on-exception + keep-alive/port-exhaustion (D8); resource lifecycle via try-with-resources/context-managers + streaming large payloads (D8); idempotency keys + backoff **with jitter** + bounded retry + outbox/saga (D6/D7); backpressure + rate limiting + cache **invalidation** required with any cache (D9).

**Missing dimensions added:** requirement→code traceability + scope-creep (D1); breaking-change/back-compat + consumer blast radius (D10); migration reversibility / expand-contract / rollback (D6); observability of the change itself (D14); dependency/supply-chain + license + CVE (D15); PII/compliance + retention + no-PII-in-logs (D3/D14); feature-flag rollout safety + stale-flag cleanup; a11y/i18n (D17); LLM trust-boundary/prompt-injection if code calls an LLM; dead-code/orphan from the change.

**Process gaps closed:** reviewer isolation (clean context packet); false-positive control (confidence≥80 + adversarial multi-vote); review **introduced lines only**, not pre-existing issues; verify-before-claim (cite file:line/test name; ban "likely handled"); human-escalation criteria batched into one `AskUserQuestion`; incremental re-review with cached verdicts; strengths-first, no performative-agreement tone.

## Human "worst case" config (escape hatch)

Per-project `.review/config.yml` (+ a `review-config` skill) declaring floors the agent cannot skip:

```yaml
risk_map:
  critical: ["src/payment/**", "**/*Migration*", "src/auth/**"]
  high:     ["src/api/**", "**/*.proto"]
mandatory_checks:
  - "connection pool max size set and justified"
  - "no PII in logs"
  - "idempotency key on payment mutations"
project_rules: ["CLAUDE.md", "AGENTS.md", "docs/architecture.md"]
intent_sources: { clickup: true, jira: true, pr: true, commits: true }
gate: { block_on: [critical], warn_on: [high] }
knowledge_packs: { java: [...], ts: [...] }
```

Triage still decides depth; `mandatory_checks` and `risk_map` are floors.

## Model assignment

```
haiku   → eligibility, triage classification, comment accuracy, confidence scoring, trivial intent
sonnet  → standard dimension reviews, intent harvest, synthesis
opus    → security, concurrency, perf-hot-path, migrations, adversarial verify, Critical-PR synthesis
```
Principle: cheap to decide, expensive to be sure. Opus only where cost-of-miss is high.

## Build order

1. `triage-classifier` + `review-config` schema/risk-map → validate on sample diffs
2. Orchestrator with Standard tier only, reusing existing agents as-is
3. Merge 3 code-reviewers → 1; demote skills to packs
4. `intent-harvester` (PR+commits first; ClickUp/Jira MCP second)
5. `finding-verifier` + confidence filter (trust layer)
6. `/review` command + delivery sinks
7. Hooks (local → pre-push → CI Action)
8. Remaining new dimensions (D7/D9/D10/D14/D15/D17)

## Non-goals

- No code mutation / auto-fix (advisory only).
- No per-language full pipelines (packs cover specialization).
- No re-flagging pre-existing issues outside the diff.
- No deep multi-hour analysis on trivial changes (triage prevents it).

## Open risks & mitigations

- **False positives erode trust** → confidence≥80 filter + adversarial verify on High/Critical; review changed lines only.
- **Token blowup** → triage gating + content-gated dimensions + model tiering + incremental re-review.
- **Intent sources unavailable in CI** (interactively-auth'd MCP) → fall back to PR body + commits; degrade gracefully.
- **Over-trust of the gate** → verdict is advisory-blocking with documented override (`--no-verify`); humans own merge.
