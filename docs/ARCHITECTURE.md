# Adversarial Code Review — How it works

A field guide to the plugin's internals, written for someone who has never seen the
code before. It explains **what the plugin does**, **how a change flows through it**,
and **where every decision is actually made** — with diagrams you can follow without
reading a line of source.

> **One-sentence summary:** it reads a diff, measures how dangerous the change is,
> reviews only the dimensions that matter at a depth that matches the risk,
> adversarially re-checks the findings it isn't sure about (bounded to 3 looks),
> and reports the result — **it never edits your code.**

- New here? Start at [Mental model](#mental-model).
- Want the install steps? See the [README](../README.md#install).
- Want to know *why a tier was chosen*? Jump to [The triage brain](#the-triage-brain).

---

## Mental model

Two kinds of work happen inside the plugin, and keeping them separate is the whole design:

| | **Deterministic scripts** (`lib/*.mjs`) | **Subagents** (`agents/*.md`) |
|---|---|---|
| Do | the cheap, repeatable, *decidable* work | the judgment calls |
| Examples | diffing, signal extraction, tier selection, sharding, the verify policy, rendering, memory | reading code for bugs, deciding if a finding is real |
| Cost | ~free (pure Node, no LLM) | a model call — spent only where earned |
| Property | same input → same output, unit-tested | isolated, advisory, confidence-gated |

The scripts decide **what to do and how much to spend**; the models do the part that
genuinely needs a model. No model call decides a tier — a model only sanity-checks the
tier a script computed. This is what keeps a typo cheap and an auth change thorough.

```mermaid
flowchart LR
  subgraph det["Deterministic — lib/*.mjs (no model)"]
    direction TB
    SIG[signals.mjs<br/>diff → signals]
    TRI[triage.mjs<br/>signals → tier, dims, models]
    SHA[shard.mjs<br/>big diff → review units]
    VER[verify.mjs<br/>which findings to re-check + the cap]
    ROU[route.mjs<br/>extra-intent + forced checks + spawn ledger]
    REN[render.mjs<br/>findings → report + verdict]
  end
  subgraph jud["Judgment — agents/*.md (a model call each)"]
    direction TB
    REV[17 dimension reviewers]
    VF[finding-verifier / taint-verifier]
    SYN[review-synthesizer]
  end
  det -->|a plan + a budget| jud
  jud -->|findings| det
```

---

## The pipeline — intake to verdict

Every review runs the same eight stages. Each stage runs only when the change earns it;
a trivial change exits after stage 3.

```mermaid
flowchart TD
  A["1 · INTAKE<br/><i>preflight.mjs</i><br/>verify node, git, work tree"]
  B["2 · CONTEXT<br/><i>gather.mjs · memory.mjs · scan.mjs</i><br/>PR body, existing comments,<br/>ClickUp/Jira, prior learnings, CVE scan"]
  C["3 · TRIAGE<br/><i>plan.mjs + triage.mjs</i><br/>diff → tier, dimensions, models,<br/>shards, verify/escalation budgets"]
  D["4 · INTENT<br/><i>intent-harvester · intent-grouper<br/>· business-logic-analyzer</i><br/>stated vs actual, primary vs extra,<br/>open questions"]
  E["5 · REVIEW<br/><i>correctness-reviewer + specialists</i><br/>one isolated pass per dimension × shard"]
  F["6 · VERIFY<br/><i>finding-verifier / taint-verifier</i><br/>adversarially refute only the unsure findings"]
  G["7 · SYNTHESIZE<br/><i>review-synthesizer</i><br/>dedupe, traceability matrix,<br/>needs-human list, one verdict"]
  H["8 · DELIVER<br/><i>report.mjs · comments.mjs · pr-comment-author</i><br/>REVIEW.md + REVIEW.html, gate exit code,<br/>inline comments, memory write"]

  A --> B --> C
  C -->|"tier == trivial"| H
  C -->|"tier >= low"| D --> E --> F
  F -->|"high / critical only"| G
  E -.->|"low / standard:<br/>ship at >=80 gate"| G
  G --> H
  G -.->|"exhaustive (Tier C)"| X["8b · COMPLETENESS SWEEP<br/><i>completeness-critic</i><br/>what did we MISS?"]
  X -.->|new findings| F
```

What each stage contributes:

1. **Intake** — `preflight.mjs` checks Node + git are present (and notes whether `gh` and the CVE scanners are available). Hard-fails fast so you don't waste a review on a broken environment.
2. **Context** — `gather.mjs` pulls the PR body, **existing PR/inline comments**, linked ClickUp/Jira tickets, and project rules into one bundle; `memory.mjs` loads prior learnings (recurring findings, accepted false-positives, open questions); `scan.mjs` runs `npm audit` / `pip-audit` when available to seed the dependency dimension. Missing tools degrade gracefully and are noted in the report.
3. **Triage** — the brain. See [The triage brain](#the-triage-brain).
4. **Intent** — builds the acceptance-criteria model: what the change *says* it does (PR/comments/tickets) vs. what the code *actually* does, and where the two diverge. Splits the primary intent from **extra / unexplained** changes and flags the extras for scope-creep control. Material business-logic ambiguities become *questions for you*, not silent assumptions.
5. **Review** — fans out reviewers. The always-on `correctness-reviewer` plus one specialist per planned dimension, each on the model `triage` chose for that dimension, each on its own shard for large diffs. Every reviewer gets a **clean packet** (intent + criteria + diff) and never the chat history.
6. **Verify** — the bounded adversarial pass. See [Bounded adversarial verification](#bounded-adversarial-verification).
7. **Synthesize** — `review-synthesizer` dedupes, builds the requirement→code traceability matrix, separates confident findings from open questions, and emits one verdict.
8. **Deliver** — `report.mjs` writes `REVIEW.md` + `REVIEW.html`, prints a terminal summary, and (with `--gate`) returns the gate as an exit code; `--comment` posts inline PR comments via `pr-comment-author` + `comments.mjs`; the run is recorded to memory; unresolved questions are surfaced to you.

---

## The triage brain

Triage is **pure, dependency-free logic** (`lib/triage.mjs`, fed by `lib/signals.mjs`).
No model decides the tier. It runs in three steps: compute a base tier from the diff's
signals, **raise** it if a configured risk path is touched, then add content-gated
dimensions on top.

### Step 1 — base tier from signals

```mermaid
flowchart TD
  S{"doc-only change?<br/>(all files .md/.txt/.rst/…)"}
  S -->|yes| TRIV([trivial])
  S -->|no| H{"hot? risk path touched<br/>OR public contract<br/>OR concurrency touched"}
  H -->|yes| CRIT([critical])
  H -->|no| L{"<= 3 files AND<br/><= 40 net LOC AND<br/>tests present"}
  L -->|yes| LOW([low])
  L -->|no| STD([standard])
```

Risk paths are matched by `signals.mjs` against filename patterns: `auth`, `payment`,
`migration` / `*.sql`, `crypto`, `infra` (Dockerfile, `*.tf`, k8s/helm), and `secrets`.

### Step 2 — the `risk_map` floor (can only *raise*)

Your `.review/config.json` defines glob → tier floors. A glob hit raises the tier to its
floor; it can **never** lower a change below the risk its path implies.

```mermaid
flowchart LR
  BASE["base tier<br/>(from step 1)"] --> RM{"any file matches a<br/>risk_map glob?"}
  RM -->|"matches a 'critical' glob<br/>(auth/** payment/** *migration* *.sql crypto/**)"| RC["raise to >= critical"]
  RM -->|"matches a 'high' glob<br/>(api/** *.proto controller/**)"| RH["raise to >= high"]
  RM -->|no match| KEEP["keep base tier"]
```

A forced `--tier <t>` sets a floor too — `risk_map` can still raise above it, and the
whole plan (dimensions, models, verify) is recomputed from the result, so an override is
a real depth change, not a relabel.

### Step 3 — dimensions, then models

Each tier ships a base set of dimensions; content signals add more on top.

```mermaid
flowchart TD
  T["resolved tier"] --> BASESET["base dimensions for the tier"]
  BASESET --> ADD["+ content-gated dimensions"]
  ADD --> M["pick a model per dimension"]

  subgraph gates["content gates (added regardless of tier)"]
    direction LR
    g1["deps changed → D15"]
    g2["public contract → D10"]
    g3["migration → D6"]
    g4["concurrency → D7"]
    g5["error handling → D4"]
    g6["types touched → D11"]
    g7["perf-sensitive → D9"]
    g8["UI files → D17"]
    g9["java/sql → D6"]
  end
  ADD -.-> gates
```

**Base dimensions per tier** (from `TIER_DIMENSIONS` in `triage.mjs`):

| Tier | Base dimensions |
|------|-----------------|
| trivial | D2, D13 |
| low | D1, D2, D5, D16 |
| standard | D1, D2, D4, D5, D12, D16 |
| high | D1, D2, D4, D5, D10, D11, D12, D16 |
| critical | D1, D2, D3, D4, D5, D6, D7, D8, D12, D14 |

**Model tiering** — `opus` is reserved for the three hardest dimensions (D3 security,
D7 concurrency, D9 perf) and for a migration (D6 → opus whenever the `migration` risk
path is detected); everything else runs on the tier's model (`haiku` at trivial,
otherwise `sonnet`). The adversarial verifier runs on `opus`.

---

## The tier ladder

Five rungs. Each adds reviewers and depth over the one below. Most diffs land low, so most
reviews stay cheap — and the verification pass only kicks in from **High** up.

| Tier | Example change | What runs | Verify? |
|------|----------------|-----------|---------|
| **Trivial** | typo, comment, doc-only | one quick inline pass — no subagents | no |
| **Low** | small localized logic, with tests | a single reviewer | no |
| **Standard** | a normal feature or bugfix | correctness + screens + simplify | no |
| **High** | shared lib, API contract, hot path | full fan-out + bounded verify | **yes** |
| **Critical** | auth, payments, migrations, crypto, concurrency | all dimensions, deepest models, verify + exhaustive | **yes** |

`risk_map` and `mandatory_checks` in the config are **floors** triage cannot skip.

---

## Bounded adversarial verification

The plugin doesn't trust its own first pass — but it doesn't re-run the whole review
either. It re-checks **only the aspects a reviewer was unsure about**, and looks at any
one aspect **at most three times total** (1 review + ≤ 2 verifier passes), with **at most
3 subagents** on it. Both caps are enforced in code (`verify.mjs` slices verdicts to the
budget; `route.mjs spawn` is the ledger the orchestrator must clear before every dispatch).

### Which findings get a second look (`selectForVerification`)

```mermaid
flowchart TD
  F["a finding"] --> U{"reviewer flagged<br/>uncertain: true?"}
  U -->|yes| V[[verify it]]
  U -->|no| C{"confidence missing<br/>or < reverify_below (80)?"}
  C -->|yes| V
  C -->|no| HOT{"high-severity<br/>AND on a risk path?"}
  HOT -->|yes| V
  HOT -->|no| K[[keep as-is, no verify]]
```

High-confidence findings off the risk paths are **not** re-checked — they ship directly.

### The adversarial lens

A second look is not "re-read the guards" — each verifier attacks from a
**dimension-appropriate angle** (`VERIFY_LENS` in `verify.mjs`), so correlated blind
spots don't survive where the cost-of-miss is highest:

| Finding dimension | Lens | Verifier |
|---|---|---|
| D3 security | follow the taint: source → sink, dominating guard? | **taint-verifier** |
| D7 concurrency | construct a racing schedule; happens-before | finding-verifier |
| D6 data | transaction scope, reversibility, partial failure | finding-verifier |
| D8 resources | is every handle released on *every* path? | finding-verifier |
| D9 perf | realistic input scale, super-linear blow-up | finding-verifier |
| D4 / D10 / D11 / D14 | error path / contract break / illegal state / visibility | finding-verifier |
| anything else | re-read the real code path on the changed lines | finding-verifier |

### How a verdict is decided (`resolveVerification`)

The verifier returns `real` / `refuted` / `uncertain`. The fate is decided
deterministically — note the **asymmetric burden of proof** that protects high-severity
findings from a single refuter:

```mermaid
flowchart TD
  START["verifier verdicts<br/>(capped to <= 2)"] --> N0{"no verifier ran?"}
  N0 -->|yes| KEEP1([keep])
  N0 -->|no| CMP{"refuted vs real"}

  CMP -->|"refuted > real"| RF{"high-severity<br/>AND only 1 refuter<br/>AND a 2nd look was affordable<br/>AND escalation on?"}
  RF -->|yes| NH1([needs-human])
  RF -->|no| DROP([drop])

  CMP -->|"real > refuted"| RL{"entered because it was<br/>low-confidence AND < 2 'real' votes?"}
  RL -->|yes| NH2([needs-human])
  RL -->|no| KEEP2(["keep — confidence raised to >= 80"])

  CMP -->|"tie / all-uncertain"| NH3([needs-human])
```

All three `needs-human` outcomes above are **escalation-gated**: with
`escalate_uncertain: false` they become `drop` instead. It defaults to **on**, so the
diagram shows the default path.

Then `partition` splits the resolved set three ways: **report** (kept, confidence ≥ 80),
**dropped** (refuted false positives, removed silently), and **needs-human** (anything
still split, or that survived but stayed below the floor) — *never silently dropped.*

---

## Exhaustive mode (Tier C)

By default a non-exhaustive review runs its reviewer fan-out **once** and ships. Exhaustive
mode trades extra tokens for fewer misses. It turns on with `--exhaustive`, or
automatically at the `critical` tier (`exhaustive.on_critical`, default true).
`exhaustivePlan()` flips four passes on together:

```mermaid
sequenceDiagram
  participant R as Review fan-out
  participant V as Verify
  participant S as Synthesize
  participant CC as completeness-critic

  Note over R: loop-until-dry — re-sweep finders<br/>up to max_discovery_rounds, stop on a dry round
  R->>R: round 1 … N (dedup by file:line:title)
  R->>V: all findings
  Note over V: generative verify — a verifier may surface<br/>up to 2 adjacent findings (one extra round only)
  Note over V: taint pass — D3 findings routed to taint-verifier
  V->>S: kept findings
  S->>CC: coverage matrix + kept + skipped dims + risk paths
  Note over CC: false-negative guard — what did we MISS?<br/>(max 6 bounded gaps, each a targeted re-dispatch)
  CC->>V: new findings from the gaps
  V->>S: re-synthesize with the new findings
```

The four passes:

- **loop-until-dry** — repeat the fan-out until a round adds nothing new (capped at `max_discovery_rounds`). A single sweep misses the tail.
- **generative verify** — on the first verify pass, a verifier may emit up to 2 *adjacent* findings, not just refute. Bounded to exactly one extra round (the second pass forces `generative:false`, so no recursion).
- **taint pass** — D3 security findings route to the data-flow `taint-verifier` instead of the generic verifier.
- **completeness-critic** — runs *after* synthesis, aimed at what the review **missed** (an unrun dimension, an uncovered criterion, an untraced taint, an unverified claim). Returns ≤ 6 bounded gaps, each a concrete re-dispatch. It does **not** loop.

Every re-dispatch — in every pass — still clears the same spawn ledger, so the per-aspect
cap (≤ 3) holds across rounds.

---

## The agents (23 bundled)

All ship with the plugin — it's self-contained. Each reviewer is **isolated** (a clean
packet: intent + criteria + diff, never the chat history), **changed-lines-only**, and
**confidence-gated at 80**. The model column is each agent's default; at dispatch the
orchestrator uses `plan.models[dimension]`, so a dimension can run hotter than its default
(e.g. `data-store-reviewer` runs on opus for a migration).

### Orchestration & verification

| Agent | Model | Role |
|---|---|---|
| `triage-classifier` | haiku | Sanity-checks the computed tier; may raise it, never silently lowers a risk path. |
| `intent-harvester` | sonnet | Stated intent (PR/comments/tickets) vs. derived intent (the code) + mismatches. |
| `intent-grouper` | sonnet | Splits the primary intent from extra/unexplained changes; flags the extras. |
| `business-logic-analyzer` | sonnet | Models the domain; turns material ambiguity into questions, not guesses. |
| `finding-verifier` | opus | Adversarial — tries to refute one finding along its lens. |
| `taint-verifier` | opus | Data-flow security verifier — traces source → sink for D3 findings. |
| `completeness-critic` | opus | Tier C false-negative guard — hunts for what the review missed. |
| `review-synthesizer` | sonnet | Dedupe, traceability matrix, needs-human list, final verdict. |
| `pr-comment-author` | sonnet | Turns findings into toned inline comments with a suggested-fix snippet. |

### Dimension specialists

| Dim | Agent | Model | Covers |
|---|---|---|---|
| D1/D2/D12 | `correctness-reviewer` | sonnet | intent, correctness & quality, project-rules + a security/test screen. **Always on.** |
| D3 | `vuln-reviewer` | opus | OWASP, injection, authz, secrets, crypto, SSRF, LLM trust-boundary. |
| D4 | `error-handling-reviewer` | sonnet | silent failures, broad catch, leaked detail, unbounded retry. |
| D5 | `test-adequacy-reviewer` | sonnet | critical-path & error-branch coverage, edge cases, brittle/flaky. |
| D6/D8 | `data-store-reviewer` | sonnet · opus on migration | N+1, indexes, tx scope, migration safety, pooling, leaks. |
| D7 | `concurrency-reviewer` | opus | races, deadlock, idempotency, bounded pools, retry+jitter. |
| D9 | `perf-scalability-reviewer` | opus | complexity, caching + invalidation, backpressure, memory. |
| D10 | `api-compat-reviewer` | sonnet | breaking changes, versioning, consumer blast radius. |
| D11 | `type-design-reviewer` | sonnet | invariants, illegal states unrepresentable, encapsulation. |
| D13 | `docs-comment-reviewer` | haiku | comment rot, stale README/ADR, missing public-API docs. |
| D14 | `observability-reviewer` | sonnet | failure modes instrumented, log hygiene, no PII in logs. |
| D15 | `dependency-reviewer` | sonnet | CVEs (from the scan), license, pinning, typosquat. |
| D16 | `simplification-reviewer` | sonnet | dead code, over-abstraction, nesting. Suggests, never edits. |
| D17 | `a11y-i18n-reviewer` | sonnet | aria, semantics, keyboard, contrast, externalized strings, RTL. |

---

## Configuration — `.review/config.json`

Created by `/review-init`; validated against `.review/config.schema.json`. Every key is
optional and falls back to a sensible default.

| Key | What it controls |
|---|---|
| `risk_map` | glob → tier floors (`critical`, `high`). Can only **raise** a tier. |
| `mandatory_checks` | checks applied as forced review items at every tier (mapped to a dimension by `route.mjs`). |
| `project_rules` | house rules fed into every reviewer packet (drives D12). |
| `intent_sources` | toggle PR / commits / pr_comments / clickup / jira as intent inputs. |
| `gate` | `block_on` / `warn_on` severity lists → the `APPROVE`/`WARN`/`BLOCK` verdict. |
| `verify` | bounded-verify policy: passes/aspect, subagents/aspect, `reverify_below`, `report_confidence`, `escalate_uncertain`. |
| `escalation` | spawn-on-doubt cap (subagents per aspect). |
| `large_diff` | `shard_threshold_loc`, `max_shards`. |
| `scan` | run `deps` / `tests` / `lint` tools when available (advisory). |
| `report` | output paths for the markdown + HTML reports. |
| `learning` | per-project memory: `enabled`, `store` path. |
| `notify` | `ask_on_unresolved` — surface open questions instead of assuming. |
| `trackers` | ClickUp/Jira connectors. **Tokens come from env vars, never the config file.** |
| `exhaustive` | Tier C passes: `on_critical`, `max_discovery_rounds`. |

The schema also reserves a `knowledge_packs` key; it is currently unused (no `lib/`
or command path reads it).

---

## Where every decision lives

A map from "the thing the plugin does" to "the file that decides it" — handy when reading
the source or filing a bug.

| Decision | File | Function |
|---|---|---|
| diff → classification signals | `lib/signals.mjs` | `computeSignals` |
| signals → tier / dimensions / models | `lib/triage.mjs` | `planReview`, `baseTier`, `applyRiskMap`, `pickModels` |
| is this an exhaustive run? | `lib/triage.mjs` | `exhaustivePlan` |
| big diff → review shards | `lib/shard.mjs` | `shouldShard`, `shardFiles` |
| which findings to re-verify | `lib/verify.mjs` | `selectForVerification`, `lensFor` |
| a finding's fate after verify | `lib/verify.mjs` | `resolveVerification`, `partition` |
| extra-intent scrutiny / forced checks / spawn cap | `lib/route.mjs` | `extraScrutinyTargets`, `forcedChecks`, `recordSpawn` |
| findings → report + verdict | `lib/render.mjs` | `renderReport`, `renderHtml`, `renderVerdict` |
| render + gate + memory record | `lib/report.mjs` | (CLI) |
| inline PR comments via `gh` | `lib/comments.mjs` | (CLI) |
| PR / comments / trackers → context | `lib/gather.mjs` | (CLI) |
| per-project learnings store | `lib/memory.mjs` | `findingKey`, load/record |
| dependency CVE scan | `lib/scan.mjs` | (CLI) |
| environment check | `lib/preflight.mjs` | (CLI) |
| the orchestration prose | `commands/review.md` | the pipeline step by step (9 numbered sections + the `8b` completeness sweep) |

---

## Design principles

- **Portable, zero-dependency** — pure ESM `.mjs`, only Node ≥ 18 + git required. No `npm install`.
- **Cheap to decide** — deterministic triage; models and verifiers spend only where risk warrants.
- **Reviewer isolation** — each agent gets a clean packet, never the chat history.
- **False-positive control** — confidence ≥ 80, adversarial verify with per-dimension lenses, accepted-FP memory.
- **Doubt is surfaced, not hidden** — unresolved findings (and lone refutations of high-severity findings) go to "needs human".
- **Changed lines only** — pre-existing issues outside the diff are not flagged.
- **Bounded cost** — model tiering + ≤ 3 looks / subagents per aspect.

---

*Advisory · criticality-aware · self-verifying · MIT. It never modifies your code.*
