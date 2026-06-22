# Task 6 Report — Docs: Workflow-based /review + verify-all + report guarantees

## What changed

### CLAUDE.md

**Section: `## Module convention (lib/*.mjs)`** — Added bullet after the "Comments explain the why" line:
> Workflow-DSL exception: `lib/review-workflow.mjs` is NOT a pipeline-step module — no shebang/`main`, uses harness globals (`agent`/`pipeline`/`phase`/`args`). Cannot be imported or run with `node`; inlines pure helpers whose canonical tested copies live in `lib/review-orchestration.mjs`. Keep the two in sync.

**Section: `## Where things live`** — Added bullet after the severity-vocabulary bullet:
> Review orchestration is a Workflow (`lib/review-workflow.mjs`), invoked by `commands/review.md`. The main agent only runs the deterministic scripts + the Workflow call; it never assembles the `report.mjs` payload by hand.

### README.md

**Section: `## What it does`** — Updated the bounded-adversarial-verification bullet to describe verify-all: every finding on non-trivial tiers gets a dedicated verification agent (not just uncertain ones).

**Section: `## How it works`** — Replaced the ASCII pipeline art and numbered list. New art labels the Workflow bracket. New prose states `/review` is a thin dispatcher. Steps 1–3 unchanged (deterministic scripts). Step 4 is now "Workflow fan-out" covering intent/review/verify/synthesize/report, with verify-all and report guarantees ("Agents & coverage" always present; `report.mjs` has no `--out`/`--html`). Step 5 is "Deliver" (main agent relays result).

**Section: `## Layout`** — Added `review-workflow.mjs` and `review-orchestration.mjs` entries to the lib listing.

### docs/ARCHITECTURE.md

**Section: `## The pipeline — intake to verdict`** (intro sentence) — Added note that stages 1–3 run in the main agent as deterministic scripts; stages 4–8 run inside the Workflow.

**Step 5 (Review)**, **Step 6 (Verify)**, **Step 8 (Deliver)** — Updated to reflect: Workflow owns steps 5–8; verify-all (every finding, separate agent, on tiers with `plan.runVerify` true); report guarantee ("Agents & coverage" always present; no `--out`/`--html`).

**Section: `## Where every decision lives`** — Added two new rows for `lib/review-workflow.mjs` and `lib/review-orchestration.mjs`. Updated the `commands/review.md` row from "orchestration prose" to "thin dispatcher + Workflow call".

## npm test result

PASS — 94/94 tests. `check-versions` hook did not fire (no version bump; plugin.json unchanged).

## Self-review

- Stale claims removed: main agent no longer described as assembling step-by-step review or report payloads by hand.
- Verify-all described correctly: every finding verified on non-trivial tiers, separate agent per finding.
- Report guarantees stated: per-run folder always written; "Agents & coverage" always present; `report.mjs` has no `--out`/`--html`.
- CLAUDE.md exception added exactly per brief.
- No unrelated rewrites; no version bump; no new files outside the docs + report.

## Concerns

None. Changes are surgical and limited to the three target files.

---

## Fix pass (Needs-fixes follow-up)

Stale verify-only framing that survived the first pass:

- **docs/ARCHITECTURE.md line 10** (one-sentence summary) — "re-checks the findings it isn't sure about" → "re-checks every finding with its own verifier on non-trivial tiers".
- **docs/ARCHITECTURE.md line 68** (Mermaid node F) — "adversarially refute only the unsure findings" → "adversarially refute every finding (verify-all)".
- **docs/ARCHITECTURE.md `## Bounded adversarial verification` intro** — "re-checks only the aspects a reviewer was unsure about" → "on every non-trivial tier (`plan.runVerify` true) the Workflow refutes every finding with its own separate verifier agent (verify-all)"; spawn-ledger note repointed from `route.mjs spawn` to the `canSpawn`/`recordSpawn` ledger in `lib/review-workflow.mjs` (canonically `lib/review-orchestration.mjs`).
- **docs/ARCHITECTURE.md `### Which findings get a second look`** — added a lead-in clarifying verify-all makes this gate moot on non-trivial tiers; `selectForVerification` is retained as the still-tested *priority* helper a budget-constrained run would follow. Diagram leaf relabeled "keep as-is, no verify" → "lowest priority".
- **README.md lines 17 + 143** — restored both caps: "≤ 3 looks and ≤ 3 subagents per aspect" (the looks cap is the re-verification-depth bound, distinct from subagents).

Left intentionally unchanged: `resolveVerification` verdict diagram's "low-confidence AND < 2 'real' votes?" branch (line ~273) — that describes the verdict-resolution burden of proof, not which findings are selected, and remains accurate.

Verification: `grep -ni "only the unsure" docs/ARCHITECTURE.md` and the broader `unsure|only.*low-confidence|select.*unsure` sweep both return nothing stale. `npm test` → 94/94, no version drift.
