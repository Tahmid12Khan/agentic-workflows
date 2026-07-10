---
description: Author-side reception of the latest /review report — verify each finding against current code, classify agree/disagree(reasoned)/needs-human (never performative agreement), and record disagreements as false-positive candidates in learnings. Opt-in `--fix` applies agreed findings one at a time with a test-run-and-revert safety net. Flags: --report <path> --fix.
---

Respond to a code review's findings **as the author** — verify before implementing, no performative agreement, reasoned pushback when a finding is wrong. This command is **read-only by default**; it never edits source. `--fix` is opt-in, off by default, and is the ONLY code-mutating path in this plugin.

Bundled scripts live under `${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/adversarial-code-review}/lib/`. Let `LIB` be that path. Run with bare `node` (see `/review`'s note on why not `command node`).

## 1. Locate the report
`node "$LIB/respond.mjs" find --dir .adversarial-code-review`, or with `--report <path>` add `--report <path>` to use that folder instead of the latest one. Reads `{ folderPath, findings, notes }`.

If `folderPath` is null, relay `notes` (tells the user to run `/review` first) and STOP.

## 2. Scope guard
`node "$LIB/respond.mjs" scope${--fix passed ? ' --fix' : ''}` → `{ dirty, detachedHead, blocked, reason }`.

If `blocked`, show `reason` and STOP before dispatching anything — no writes, no agent call. (The guard only fires for `--fix`: a dirty tree or detached HEAD is fine for the read-only classification pass; it only becomes a hazard once the run is going to write. `--fix` refuses a dirty tree because an edit could get mixed with unrelated uncommitted changes, and refuses a detached HEAD because a fix has to land on a real branch.)

## 3. Classify every finding
Dispatch the `finding-responder` subagent ONCE with the full `findings` array from step 1. Tell it plainly whether this run has `--fix` requested (even if requested, it is **not yet confirmed** — say so explicitly; the agent must not apply anything until step 4 confirms). It returns `{ responses: [...] }`.

Validate the shape before trusting it: pipe the agent's raw JSON through `node "$LIB/respond.mjs" validate` (stdin: `{"responses": [...]}`). If it exits non-zero, show the `errors` and ask the subagent to correct only the offending entries — do not silently drop them. Surface any `warnings` (e.g. an uncited disagree, or performative language that slipped through) to the user even when the batch is otherwise valid.

Present the classification to the user now, regardless of `--fix`: how many agree / disagree / needs-human, each disagree's cited evidence, and each needs-human question.

## 4. Record disagreements as FP candidates
Every `disagree` response is a false-positive candidate for the review's learning loop (Workstream 2 reads these back on a later `/review`). Run:
```
echo '{"responses": <responses>, "findings": <findings from step 1>}' | node "$LIB/respond.mjs" record
```
Report `recorded` (how many landed in learnings) and `store` (the learnings path) to the user.

## 5. `--fix` only: apply agreed findings
Skip this step entirely without `--fix` — the command is done after step 4.

With `--fix`:
- If there are zero `agree` responses, say so and STOP (nothing to apply).
- Otherwise **present a summary** (the list of `agree` findings that would be edited, each file:line) and **ask the user to confirm once, explicitly, before any write happens**. Do not proceed on an assumed yes. If they decline, stop here — the classification from step 3 still stands and is already recorded.
- On confirmation, dispatch (or continue) `finding-responder` telling it `--fix` is now confirmed. It applies each `agree` finding **one at a time** via its own `node "$LIB/respond.mjs" apply` calls (see the agent's own instructions for the exact protocol) — the script itself runs the project's configured test command after each edit and reverts if it regresses, so you never need to intervene mid-apply.
- Relay the final per-finding outcome: applied / reverted-due-to-test-regression / not-applied-and-why. Never claim something was fixed unless its `applied` field said `true`.

## Output discipline
No performative agreement, ever — a "You're absolutely right" / "Great catch" / bare "Thanks" in this command's own output is a bug, not politeness. Cite file:line for every disagreement. Never edit source outside the confirmed `--fix` path in step 5.
