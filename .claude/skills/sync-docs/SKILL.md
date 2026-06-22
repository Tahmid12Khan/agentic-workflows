---
name: sync-docs
description: Keep README.md and docs/ARCHITECTURE.md in sync with the adversarial-code-review code. Use after changing behavior — a review dimension, a CLI flag, config keys, worktree or MCP-tracker behavior, or the version — to reconcile the docs in the same change.
---

# Sync the docs

`README.md` (user-facing) and `docs/ARCHITECTURE.md` (the field guide) are the contract. They drift the moment code behavior changes. This skill maps a code change to the doc sections it affects so nothing is left stale.

## How to use it

1. Find what changed: `git diff <base>..HEAD --stat` (or the diff of the current change). Identify which categories below it touches.
2. For each touched category, open the listed sections and reconcile them with the code. Read the real code/config — don't guess.
3. Re-read the edited sections top-to-bottom once: counts, tables, and prose claims must all agree with each other and the code.

## Change → docs map

| When you change… | README sections | docs/ARCHITECTURE.md sections |
|---|---|---|
| A review dimension (`lib/triage.mjs` maps + a new `agents/*-reviewer.md`) | "Dimensions & agents" table; every dimension-count and agent-count claim (intro, "What it does", "Layout", Roadmap) | "The agents" dimension table + heading count; "Step 3 — dimensions, then models" (`TIER_DIMENSIONS` table + content-gates list); the Mental-model flowchart's dimension-reviewers node; "Bounded adversarial verification" lens table if a verify lens was added |
| A `/review` CLI flag or command (`commands/review.md`) | "/review flags" table (Quickstart); any feature bullet citing the flag (`--no-worktree`, `--exhaustive`, `--gate`/`--comment`); "Layout" commands line; Install if a command was added/removed | "Deliver" stage + "Where every decision lives" `commands/review.md` row; worktree/exhaustive sections if those flags' semantics changed |
| `config.schema.json` keys | "Configuration" key list (+ trackers/worktree/MCP note) | "Configuration" per-key table; plus the section keyed to that config (worktree → worktree sections; verify/escalation → "Bounded adversarial verification"; exhaustive → "Exhaustive mode"; risk_map/mandatory_checks → triage/tiers floors; trackers → intake/context) |
| Worktree behavior (`lib/worktree.mjs`) | "What it does" worktree bullet; Requirements "git remote" row; the preflight/worktree pipeline step; "Layout" worktree.mjs line; config worktree key; Roadmap done-item | "Reviewing the latest pushed code" (setup steps, naming scheme, config shape, fallback); "Where every decision lives" worktree.mjs row |
| MCP-tracker behavior (`lib/gather.mjs`) | "What it does" intent bullet; Requirements MCP row; the Context pipeline step; config `trackers` note; Roadmap done-item | "Context" stage; Configuration `trackers`/`intent_sources` rows; "Where every decision lives" gather.mjs row |
| Plugin version | Roadmap "Done (v<new>)" + any "v<old> adds…" prose | re-check any "v<old> adds…" notes and feature claims (agent/dimension counts) the release changes |

## Notes

- Counts are the most common rot: dimension counts and the bundled-agent count appear in several places in each doc. When the set changes, grep both files for the old number and fix every hit.
- `config.schema.json` has no dimension enum — dimensions are defined in `lib/triage.mjs`. Don't look for them in the schema.
- Run this as part of `/add-reviewer-dimension` step 6 and `/release-plugin` step 3.
