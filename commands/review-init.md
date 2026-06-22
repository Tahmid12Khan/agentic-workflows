---
description: Set up code review in this project — checks your environment and scaffolds .adverserial-code-review/config.json.
---

Initialize the adversarial-code-review plugin for the current repository.

## 1. Environment check
Run `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/preflight.mjs"` and show the report. If a required item is missing (✗), tell the user how to fix it before continuing.

## 2. Scaffold the config
- If `.adverserial-code-review/config.json` already exists, print it and ask whether to overwrite. Do nothing else unless they confirm.
- Otherwise, detect the repo's main languages/areas (glob the tree: `*.java`, `*.ts`, `*.py`, `*.sql`, migrations, an `auth/`, `payment/`, or `api/` dir, a `package.json`/`pom.xml`/`requirements.txt`). Write a tailored `.adverserial-code-review/config.json`. Start from this template and adjust `risk_map` to the paths that actually exist:

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
  "intent_sources": { "pr": true, "commits": true, "pr_comments": true, "clickup": true, "jira": true },
  "trackers": {
    "clickup": { "key_pattern": "[A-Z][A-Z0-9]+-[0-9]+" },
    "jira": { "key_pattern": "[A-Z][A-Z0-9]+-[0-9]+" }
  },
  "gate": { "block_on": ["critical"], "warn_on": ["high"] },
  "verify": { "max_passes_per_aspect": 3, "max_subagents_per_aspect": 3, "reverify_below": 80, "report_confidence": 80, "escalate_uncertain": true },
  "escalation": { "max_subagents_per_aspect": 3 },
  "exhaustive": { "on_critical": true, "max_discovery_rounds": 2 },
  "large_diff": { "shard_threshold_loc": 600, "max_shards": 4 },
  "scan": { "deps": true, "tests": false, "lint": false },
  "worktree": { "enabled": true, "remote": "origin", "base_dir": ".adverserial-code-review/worktrees", "keep": false },
  "learning": { "enabled": true, "store": ".adverserial-code-review/learnings.json" },
  "notify": { "ask_on_unresolved": true }
}
```

- Keep only `project_rules` entries for files that exist.
- The **bounded-verification** caps (`verify`, `escalation`) keep cost predictable: at most 3 looks and 3 subagents per aspect. Leave them unless the user wants tighter/looser bounds.
- **`exhaustive`** turns on the deeper ultrareview-parity passes (completeness critic, taint, generative verify, loop-until-dry). They cost more tokens, so by default they run only at the `critical` tier (`on_critical: true`) or when `/review --exhaustive` is passed. Set `on_critical: false` to make them opt-in only.
- **Trackers (on by default, via MCP — no tokens):** `intent_sources.clickup`/`jira` are enabled. Tickets referenced in the PR/commit text are pulled in as review context by the orchestrator **through the ClickUp / Atlassian MCP server** — the plugin **never stores or uses API tokens**. `trackers.<name>.key_pattern` controls how ticket keys are recognised; adjust it to match this repo's convention. If a tracker is enabled but its MCP server is not connected, `/review` asks the user to connect it and otherwise skips that tracker for the run — and the report always states whether each tracker was used. To turn one off, set its `intent_sources` flag to `false`.
- **`worktree` (on by default):** the review runs in a throwaway git worktree checked out from `remote` (default `origin`) at the PR's latest base/head, so it always sees the most recent pushed code rather than the local checkout. The worktree's name is recorded in the report. Set `keep: true` to leave it on disk for inspection (otherwise it is removed after the run), point `base_dir` elsewhere, or set `enabled: false` to review the local working tree instead (use this when reviewing **uncommitted** local changes — a worktree only sees committed refs).

Validate the result against `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/.adverserial-code-review/config.schema.json`.

## 3. Confirm
Print the path written and tell the user they can now run `/review` (and `/review --gate` in hooks/CI, `/review --comment` to post inline PR comments). Each review is written to its own folder `.adverserial-code-review/review-<date>/review-<n>[-pr-<num>]/` (`review.md` + `review.html`); add `.adverserial-code-review/review-*/`, `.adverserial-code-review/worktrees/`, `.adverserial-code-review/learnings.json`, and `.adverserial-code-review/last-review.json` to `.gitignore` if they prefer those uncommitted. NEVER edit anything except `.adverserial-code-review/config.json` (and `.gitignore` if asked).
