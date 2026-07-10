---
description: Set up code review in this project — checks your environment and scaffolds .adversarial-code-review/config.json.
---

Initialize the adversarial-code-review plugin for the current repository.

## 1. Environment check
Run `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/preflight.mjs"` and show the report. If a required item is missing (✗), tell the user how to fix it before continuing.

## 2. Scaffold the config
- If `.adversarial-code-review/config.json` already exists, print it and ask whether to overwrite. Do nothing else unless they confirm.
- Otherwise, detect the repo's main languages/areas (glob the tree: `*.java`, `*.ts`, `*.py`, `*.sql`, migrations, an `auth/`, `payment/`, or `api/` dir, a `package.json`/`pom.xml`/`requirements.txt`). Write a tailored `.adversarial-code-review/config.json`. Start from this template and adjust `risk_map` to the paths that actually exist:

```json
{
  "risk_map": {
    "critical": ["**/auth/**", "**/payment/**", "**/*migration*", "**/*.sql", "**/crypto/**"],
    "high": ["**/api/**", "**/*.proto", "**/controller/**"]
  },
  "mandatory_checks": [
    "no secrets or tokens committed",
    "external input is validated at the boundary",
    "new behavior is covered by a test"
  ],
  "project_rules": ["CLAUDE.md", "AGENTS.md"],
  "review_instructions": "REVIEW.md",
  "intent_sources": { "pr": true, "commits": true, "pr_comments": true, "clickup": true, "jira": true },
  "trackers": {
    "clickup": { "key_pattern": "[A-Z][A-Z0-9]+-[0-9]+" },
    "jira": { "key_pattern": "[A-Z][A-Z0-9]+-[0-9]+" }
  },
  "gate": { "block_on": ["critical"], "warn_on": ["high"] },
  "verify": { "max_passes_per_aspect": 3, "max_subagents_per_aspect": 3, "reverify_below": 80, "report_confidence": 80, "escalate_uncertain": true },
  "escalation": { "max_subagents_per_aspect": 3 },
  "exhaustive": { "on_critical": true },
  "large_diff": { "shard_threshold_loc": 600, "max_shards": 4 },
  "scan": { "deps": true, "tests": false, "lint": false },
  "checkout": { "enabled": true, "remote": "origin" },
  "learning": { "enabled": true, "store": ".adversarial-code-review/learnings.json" },
  "notify": { "ask_on_unresolved": true }
}
```

- Keep only `project_rules` entries for files that exist.
- **`project_rules` vs `review_instructions`** — two different channels. `project_rules` is a list of *paths* to general repo conventions (e.g. `CLAUDE.md`), surfaced to the reviewers as low-priority context. `review_instructions` is a single path (default `REVIEW.md`) whose **content** is injected verbatim as a **MANDATORY, highest-priority** block leading every finding-generating agent (reviewers + intent + critic) — use it for review-specific "always check X / never flag Y" guidance that must win over general conventions. Defaults to `REVIEW.md` by convention; drop the key or delete the file to disable. Content is capped at 8k.
- The **bounded-verification** caps (`verify`, `escalation`) keep cost predictable: at most 3 looks and 3 subagents per aspect. Leave them unless the user wants tighter/looser bounds. Spend is **tier-aware**: reviewer models scale by tier (opus only on the hardest dimensions at high/critical — override with `models`), the simplification pass (D16) is **opt-in below the high tier** (add `"always_dims": ["D16"]` to run it everywhere), and the verify confidence bar can be tuned per tier with `verify.by_tier.<tier>` (defaults 80/80 on every tier — `reverify_below` is clamped up to `report_confidence` so it never opens a dead band).
- **`exhaustive`** turns on the deeper ultrareview-parity passes (completeness critic, D3 taint verifier, and a double run of the correctness + vuln reviewers unioned by finding). They cost more tokens, so by default they run only at the `critical` tier (`on_critical: true`) or when `/review --exhaustive` is passed. Set `on_critical: false` to make them opt-in only.
- **Trackers (on by default, via MCP — no tokens):** `intent_sources.clickup`/`jira` are enabled. Tickets referenced in the PR/commit text are pulled in as review context by the orchestrator **through the ClickUp / Atlassian MCP server** — the plugin **never stores or uses API tokens**. `trackers.<name>.key_pattern` controls how ticket keys are recognised; adjust it to match this repo's convention. If a tracker is enabled but its MCP server is not connected, `/review` asks the user to connect it and otherwise skips that tracker for the run — and the report always states whether each tracker was used. To turn one off, set its `intent_sources` flag to `false`.
- **`checkout` (on by default):** before reviewing, the plugin fetches the PR's base + head from `remote` (default `origin`) and **detaches HEAD onto the latest pushed head**, then restores your original branch when done — so both the diff and the reviewers' own `Read`/`Grep` see the most recent pushed code, not a stale local checkout. The head/base it reviewed is recorded in the report. If your working tree is dirty and git would overwrite it, the run stops and asks you to `git stash`/`git commit` yourself and re-run (it never stashes for you). Set `enabled: false` (or pass `--no-checkout`) to review the working tree **in place** — required when reviewing **uncommitted** local changes.

Validate the result against `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/.adversarial-code-review/config.schema.json`.

## 3. Confirm
Print the path written and tell the user they can now run `/review` (and `/review --gate` in hooks/CI, `/review --comment` to post inline PR comments). Each review is written to its own folder `.adversarial-code-review/review-<date>/review-<n>[-pr-<num>]/` (`review.md` + `review.html`); add `.adversarial-code-review/review-*/`, `.adversarial-code-review/learnings.json`, and `.adversarial-code-review/last-review.json` to `.gitignore` if they prefer those uncommitted. NEVER edit anything except `.adversarial-code-review/config.json` (and `.gitignore` if asked).
