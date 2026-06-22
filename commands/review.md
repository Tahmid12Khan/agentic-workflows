---
description: Advisory criticality-aware code review of the current branch diff, with bounded adversarial verification. Flags: --base <ref> --comment --gate --tier <t> --dimensions <list> --incremental --exhaustive --no-worktree.
---
Run a systematic, **advisory** code review of the current change. NEVER modify source code — report only. You are a thin dispatcher: run the deterministic scripts, hand the fan-out to the Workflow, relay the result. Do not assemble report payloads by hand.

Bundled scripts live under `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/`. Let `LIB` be that path (resolve it to an absolute path). Run scripts with bare `node` — `preflight.mjs` validates node ≥ 18 and errors clearly if the resolved node is too old. (Do NOT use `command node`: on machines with a stale old node on PATH it bypasses the nvm lazy-loader and resolves the wrong version.)

## 1. Preflight
Capture the start time: `STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)`.
Run `node "$LIB/preflight.mjs"`. If it exits non-zero, show the report and STOP.

## 2. Worktree (review the latest pushed code)
Resolve base/head and create a throwaway worktree exactly as `worktree.mjs` supports: read the `worktree` config block (defaults `enabled:true`, `remote:"origin"`, `base_dir:".adverserial-code-review/worktrees"`, `keep:false`). `--base <ref>` wins; else the PR's base/head (`gh pr view --json number,baseRefName,headRefName`); else default branch vs current branch. Skip the worktree (set `WT` empty, `worktrees=[]`) when `enabled:false`, `--no-worktree`, or reviewing uncommitted local changes. Otherwise `node "$LIB/worktree.mjs" setup …` → set `WT=<path>`, record `worktrees`. Run steps 3 with `WT` as cwd.

## 3. Deterministic inputs (run from `WT` when present)
- `node "$LIB/plan.mjs" --base <baseRef>` (pass through `--tier`/`--dimensions`/`--exhaustive`) → the **plan** JSON. If `plan.tier == "trivial"`: do one quick inline correctness/comment pass, build a minimal payload (still including `plan` + `agentRuns:{}`) and skip to step 5.
- `node "$LIB/gather.mjs" --base <baseRef>` → **bundle**; fetch linked tickets via the ClickUp/Atlassian **MCP** (never API tokens); record `trackerUsage` into the bundle. If a tracker is enabled but its MCP is absent, ask once to connect, else skip.
- If `learning.enabled`: `node "$LIB/memory.mjs" load <store>` → carry as context.
- If `scan.deps`: `node "$LIB/scan.mjs"` → seed D15 findings + notes.
- Routing (deterministic): `echo '<grouper-or-empty>' | node "$LIB/route.mjs" scrutiny` and `echo '{"mandatoryChecks":<plan.mandatoryChecks>}' | node "$LIB/route.mjs" checks` → `routing = { scrutiny, checks }`.
- Capture the diff text and `plan.shards`.

## 4. Hand the fan-out to the Workflow
Call the Workflow tool — it owns intent, per-aspect review (`dimensions × shards`), per-finding verification (every finding, separate agent), resolve, synthesize, and rendering:

```
Workflow({
  scriptPath: "$LIB/review-workflow.mjs",
  args: { lib: "<absolute $LIB>", plan, bundle, diff, shards: plan.shards, routing, flags: { comment, gate, incremental, exhaustive }, startedAt: STARTED, prNumber, worktrees }
})
```

- `lib` MUST be the **resolved absolute** `$LIB` path (the executor agents use it to run `verify.mjs`/`report.mjs`; `$CLAUDE_PLUGIN_ROOT` is empty inside executor shells). Resolve it first, e.g. `LIB="$(cd "$LIB" && pwd)"`.
- `args` is delivered to the script as a **JSON string** — that is expected; the Workflow parses it (Task 4). Pass it as an object here regardless.
- It returns `{ folderPath, gate, needsHuman, notes }`. If `scriptPath` does not resolve in this install, read the file and pass its contents via `script` instead.

## 5. Deliver
- Relay `folderPath` + verdict + any `notes` to the user.
- `--comment`: `echo '{"findings":[enriched],"head":"<head>","prNumber":<n>,"existingComments":[...]}' | node "$LIB/comments.mjs"` to post inline PR comments (requires `gh`).
- Worktree teardown: if step 2 created one and `worktree.keep` is not `true`, `node "$LIB/worktree.mjs" remove --path "$WT"`.
- Incremental state: write `.adverserial-code-review/last-review.json` with this run's finding keys + range.
- Notify: if `needsHuman` is non-empty and `notify.ask_on_unresolved`, present those questions as a short numbered list; their answers are saved to `.adverserial-code-review/learnings.json`.

## Output discipline
Strengths-first, cite `file:line`, advisory only — never edit source.
