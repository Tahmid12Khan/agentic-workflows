---
description: Set up code review in this project — checks your environment and scaffolds .review/config.json.
---

Initialize the agentic-code-review plugin for the current repository.

## 1. Environment check
Run `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/agentic-code-review}/lib/preflight.mjs"` and show the report. If a required item is missing (✗), tell the user how to fix it before continuing.

## 2. Scaffold the config
- If `.review/config.json` already exists, print it and ask whether to overwrite. Do nothing else unless they confirm.
- Otherwise, detect the repo's main languages/areas (glob the tree: `*.java`, `*.ts`, `*.py`, `*.sql`, migrations, an `auth/`, `payment/`, or `api/` dir, a `package.json`/`pom.xml`/`requirements.txt`). Write a tailored `.review/config.json`. Start from this template and adjust `risk_map` to the paths that actually exist:

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
  "intent_sources": { "pr": true, "commits": true, "pr_comments": true, "clickup": false, "jira": false },
  "gate": { "block_on": ["critical"], "warn_on": ["high"] },
  "verify": { "max_passes_per_aspect": 3, "max_subagents_per_aspect": 3, "reverify_below": 80, "report_confidence": 80, "escalate_uncertain": true },
  "escalation": { "max_subagents_per_aspect": 3 },
  "exhaustive": { "on_critical": true, "max_discovery_rounds": 2 },
  "large_diff": { "shard_threshold_loc": 600, "max_shards": 4 },
  "scan": { "deps": true, "tests": false, "lint": false },
  "report": { "markdown": "REVIEW.md", "html": "REVIEW.html" },
  "learning": { "enabled": true, "store": ".review/learnings.json" },
  "notify": { "ask_on_unresolved": true }
}
```

- Keep only `project_rules` entries for files that exist.
- The **bounded-verification** caps (`verify`, `escalation`) keep cost predictable: at most 3 looks and 3 subagents per aspect. Leave them unless the user wants tighter/looser bounds.
- **`exhaustive`** turns on the deeper ultrareview-parity passes (completeness critic, taint, generative verify, loop-until-dry). They cost more tokens, so by default they run only at the `critical` tier (`on_critical: true`) or when `/review --exhaustive` is passed. Set `on_critical: false` to make them opt-in only.
- **Trackers (optional):** if the user wants ClickUp/Jira intent, set `intent_sources.clickup`/`jira` to `true` and add a `trackers` block. Tokens come from **env vars only** (`CLICKUP_TOKEN`, or `JIRA_EMAIL`+`JIRA_TOKEN` with `trackers.jira.base_url`) — never write a token into the config file. Tell the user which env vars to export.

Validate the result against `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/agentic-code-review}/.review/config.schema.json`.

## 3. Confirm
Print the path written and tell the user they can now run `/review` (and `/review --gate` in hooks/CI, `/review --comment` to post inline PR comments). Add `.review/learnings.json` and `REVIEW.html`/`REVIEW.md` to `.gitignore` if they prefer those uncommitted. NEVER edit anything except `.review/config.json` (and `.gitignore` if asked).
