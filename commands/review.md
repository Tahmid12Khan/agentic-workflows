---
description: Advisory criticality-aware code review of the current branch diff, with bounded adversarial verification. Flags: --base <ref> --comment --gate --tier <t> --dimensions <list> --incremental --exhaustive --no-checkout.
---
Run a systematic, **advisory** code review of the current change. NEVER modify source code — report only. You are a thin dispatcher: run the deterministic scripts, hand the fan-out to the Workflow, relay the result. Do not assemble report payloads by hand.

Bundled scripts live under `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/`. Let `LIB` be that path (resolve it to an absolute path). Run scripts with bare `node` — `preflight.mjs` validates node ≥ 18 and errors clearly if the resolved node is too old. (Do NOT use `command node`: on machines with a stale old node on PATH it bypasses the nvm lazy-loader and resolves the wrong version.)

## 1. Preflight
Capture the start time: `STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)`.
Run `node "$LIB/preflight.mjs"`. If it exits non-zero, show the report and STOP.

## 2. Checkout (review the latest pushed code)
Resolve base/head, fetch them, and **detach HEAD onto the latest pushed head** via `checkout.mjs` — so the reviewers' own `Read`/`Grep` see the real target code, not a stale local checkout. Read the `checkout` config block (defaults `enabled:true`, `remote:"origin"`). For head/base: `--base <ref>` wins for the base; else the PR's base/head (`gh pr view --json number,baseRefName,headRefName`); else default branch (base) vs current branch (head). Skip the checkout — review the **working tree in place** — when `enabled:false`, `--no-checkout`, or reviewing uncommitted local changes (set `ORIGINAL_REF` empty, `checkout=null`). Otherwise `node "$LIB/checkout.mjs" setup --base <base> --head <head> --remote <remote> [--pr <n>]`.

- **On non-zero exit, show its stderr and STOP.** The common case is a dirty working tree git would overwrite — `checkout.mjs` prints a stash-and-rerun instruction; relay it verbatim. It **never stashes for you** — the user must `git stash`/`git commit` themselves and re-run.
- On success, set `checkout = { baseRef, headRef, sha }` (for the report) and `ORIGINAL_REF = <originalRef>` (to restore in step 5). HEAD is now detached on the head; **steps 3+ run in the main repo** (no separate cwd) and `--base <baseRef>` makes the diff `baseRef..HEAD`.

**Stale-base check.** If setup reports `behindBase.count > 0`, the PR head is behind its base — the `base..head` diff is computed against a base the branch has not integrated, so the review can miss merge/semantic conflicts and shows base's new commits as phantom deletions. List `behindBase.commits` (sha + subject) and recommend the user rebase or merge `<base>` into the branch, then re-run; ask whether to proceed anyway. Advisory — do **not** hard-block; if the user proceeds, continue and note it in the delivered summary.

## 3. Deterministic inputs
**Token discipline — redirect every blob to a file under `$SCRATCH`; never read plan/bundle/diff into context.** Let `SCRATCH` be your scratchpad dir. The diff, plan and bundle are large (often 40–60 KB combined); reading them into context to "inspect" or to hand-assemble args is the main cost sink — don't. Only the small dynamic enrichment (a fetched ticket, the live PR object) ever touches context.

- `node "$LIB/plan.mjs" --base <baseRef>` (pass through `--tier`/`--dimensions`/`--exhaustive`) **`> "$SCRATCH/plan.json"`**. To branch on the tier, read just one field: `TIER=$(node -e 'process.stdout.write(require("$SCRATCH/plan.json").tier)')` — do **not** read the whole file. If `TIER == trivial`: do one quick inline correctness/comment pass, build a minimal payload (still including `plan` + `agentRuns:{}`) and skip to step 5.
- `node "$LIB/gather.mjs" --base <baseRef>` **`> "$SCRATCH/bundle.json"`**. Fetch linked tickets via the ClickUp/Atlassian **MCP** (never API tokens); if a tracker is enabled but its MCP is absent, ask once to connect, else skip. Write any dynamic enrichment (live PR object, fetched ticket, `trackerUsage`) as a small **`$SCRATCH/enrich.json`** — `build-args.mjs` merges it onto the bundle, so you never reshape the big bundle yourself.
- `git diff <baseRef>..HEAD > "$SCRATCH/diff.txt"` — capture, never read into context.
- If `learning.enabled`: `node "$LIB/memory.mjs" load <store>` → carry as context.
- If `scan.deps`: `node "$LIB/scan.mjs"` → seed D15 findings + notes (fold into `enrich.json`).
- Routing (deterministic): `echo '<grouper-or-empty>' | node "$LIB/route.mjs" scrutiny > "$SCRATCH/scrutiny.json"` and `echo '{"mandatoryChecks":<plan.mandatoryChecks>}' | node "$LIB/route.mjs" checks > "$SCRATCH/checks.json"`.

## 4. Hand the fan-out to the Workflow
The Workflow owns intent, per-aspect review (`dimensions × shards`), per-finding verification (the unsure findings), resolve, and synthesize. It assembles the report **payload** but no longer renders it (the sandbox can't write files; rendering moves to step 5).

**Assemble args deterministically — do not hand-build it.** Write the small `$SCRATCH/meta.json` `{ "flags": { "comment": <bool>, "gate": <bool>, "incremental": <bool>, "exhaustive": <bool> }, "startedAt": "<STARTED>", "prNumber": <n|null>, "checkout": <step-2 object|null> }`, then:

```
node "$LIB/build-args.mjs" --dir "$SCRATCH" > "$SCRATCH/args.json"
```

`build-args.mjs` reads plan/bundle/diff/routing/meta/enrich from `$SCRATCH` and emits args in the exact shape the workflow destructures (`{ plan, bundle, diff, shards, routing, flags, startedAt, prNumber, checkout }`). The bulky diff is read from disk there and **never enters your context**. Then read `args.json` **once** and pass it as the `args` value:

```
Workflow({ scriptPath: "$LIB/review-workflow.mjs", args: <contents of args.json> })
```

- Do **not** reshape, subset, or rename any field, and do **not** read `review-workflow.mjs` to infer what it wants — `build-args.mjs` already produces the complete, correct contract.
- `args` is delivered to the script as a **JSON string** — that is expected; the Workflow parses it. Pass it as an object here regardless.
- It returns `{ payload, needsHuman, notes }`. Only if the Workflow tool itself errors that `scriptPath` is unresolvable, read the file and pass its contents via `script` instead — never open it otherwise.

## 5. Deliver
- **Render the report** (also the destination for the trivial path of step 3): write the `payload` JSON to a temp file and run `report.mjs` from the **repo root**:
  `node "$LIB/report.mjs"${gate ? ' --gate' : ''} < <payload.json>`.
  Read the printed `→ <folderPath>` and `Verdict: <X>` lines from its stdout. `report.mjs` degrades soft failures (memory, file write) to stderr notes and only exits non-zero on a missing-plan/agentRuns contract violation or, with `--gate`, a BLOCK verdict.
- Relay `folderPath` + verdict + any `notes` (workflow notes + report.mjs stderr) to the user.
- `--comment`: `echo '{"findings":[enriched],"head":"<head>","prNumber":<n>,"existingComments":[...]}' | node "$LIB/comments.mjs"` to post inline PR comments (requires `gh`).
- **Restore HEAD**: if step 2 detached HEAD (`ORIGINAL_REF` set), run `node "$LIB/checkout.mjs" restore --ref "$ORIGINAL_REF"` to put the user back on their original branch. Do this **after** the report is written. If it reports `restored:false`, warn the user they are on a detached HEAD and tell them how to get back (`git checkout <ORIGINAL_REF>`).
- Incremental state: write `.adverserial-code-review/last-review.json` with this run's finding keys + range.
- Notify: if `needsHuman` is non-empty and `notify.ask_on_unresolved`, present those questions as a short numbered list; their answers are saved to `.adverserial-code-review/learnings.json`.

## Output discipline
Strengths-first, cite `file:line`, advisory only — never edit source.
