# `/review` Thin-Orchestrator + Workflow Fan-out — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/review` orchestration out of LLM-executed prose into a deterministic Workflow, and harden `report.mjs` so a wrong report path or a missing agent-coverage section becomes structurally impossible.

**Architecture:** The main agent stays thin — it runs the deterministic node steps (`preflight`/`worktree`/`plan`/`gather`/`scan`/`route`), calls one Workflow that owns all sub-agent fan-out (intent → per-aspect review → per-finding verify → synthesize), then runs the hardened `report.mjs`. Enforcement is pushed into the scripts: `report.mjs` has no path-override and throws if `plan`/`agentRuns` are missing.

**Tech Stack:** Node ≥18 ESM, zero runtime deps, `node --test` built-in runner, the Claude Code Workflow DSL (`agent`/`pipeline`/`parallel`/`phase`/`log`).

## Global Constraints

- **Zero runtime dependencies** — `node:` builtins only. `package.json` has no `dependencies`. (verbatim: golden rule #2)
- **Advisory, never edits source** — only review artifacts under `.adverserial-code-review/` and detached worktrees may be written. (golden rule #1)
- **Degrade to a note, never crash mid-run** — probe optional tools up front; on missing/failed optional tool, push a human-readable string to a notes collection and continue. Hard exit reserved for git. (golden rule #3)
- **Determinism** — no `Date`/random in identity-generating code; stable sorts use an explicit tie-break. Workflow scripts cannot call `Date.now()`/`Math.random()`/`new Date()` — pass timestamps via `args`. (golden rule #4)
- **Severity vocabulary is fixed**: `critical | important | minor | suggestion` (lowercase). Never `high`/`med`/`low`/`info`.
- **Exit codes**: `2` = usage/argument error, `1` = hard failure / gate BLOCK, `0` = success.
- **Module convention**: runnable modules have a shebang + header block, pure functions first, thin `main` last guarded by `if (import.meta.url === \`file://${process.argv[1]}\`)`. Pure-only modules have no shebang/`main` and a leading `// Pure:` comment. `arg(name, def)` is a tiny local helper, no flag library.
- **Version source of truth**: `.claude-plugin/plugin.json` (currently `0.2.0`). Do not bump here; `/release-plugin` handles it.
- **Node invocation — use bare `node`, NOT `command node`** (binding; overrides any `command node` shown in the task code blocks below). Evidence: on machines with a stale old node on PATH (this one has v14 at `/usr/local/bin`), `command node` bypasses the nvm lazy-loader and resolves the OLD node; bare `node` triggers the loader → correct version. `preflight.mjs` already guards node ≥ 18. This reverses commit 16b3511 — **Task 5 must also revert `commands/review-init.md` from `command node` back to `node`.**

---

## File Structure

- `lib/report.mjs` — **modify**: remove `--out`/`--html`; throw on missing `plan`/`agentRuns`. (the hard guarantee)
- `lib/triage.mjs` — **modify** line 96: `runVerify` true for all non-trivial tiers (verify-all policy).
- `lib/review-orchestration.mjs` — **create**: pure, tested helpers the Workflow uses (`expandAspects`, `findingKey`, `newCaps`/`canSpawn`/`recordSpawn`, `buildReportPayload`). Single source of truth for the orchestration's non-agent logic.
- `lib/review-workflow.mjs` — **create**: the Workflow-DSL script (self-contained: inlines the helpers from `review-orchestration.mjs`). Documented exception to "every `lib/*.mjs` is a pipeline step."
- `commands/review.md` — **modify**: replace the 125-line prose with a thin shim that calls the Workflow.
- `tests/cli.test.mjs` — **modify**: add `report.mjs` hardening smoke tests.
- `tests/triage.test.mjs` — **modify**: add the `runVerify` verify-all assertions.
- `tests/review-orchestration.test.mjs` — **create**: unit tests for the new pure helpers.
- `.claude/hooks/syntax-check.mjs` — **modify**: wrap `*-workflow.mjs` files in an async IIFE before `node --check` (Task 0, must land first — else the Write tool blocks the workflow file).
- `tests/hooks.test.mjs` — **create**: tests for the hook's workflow handling.
- `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` — **modify**: document the new flow + the module-convention exception.

---

## Spike findings (validated 2026-06-22, applied below)

A 2-agent Workflow spike confirmed: `Workflow({scriptPath})` resolves an absolute path; bundled `agentType` (e.g. `'correctness-reviewer'`) resolves by bare name; an executor agent can run a bundled node script. It also surfaced three things now baked into the tasks:

1. **`args` arrives as a JSON STRING**, not a parsed object. Every Workflow script must `const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {})` and read fields off `A`.
2. **`$CLAUDE_PLUGIN_ROOT` is empty outside a real plugin-command context.** Executor prompts must use a **concrete `lib`** absolute path passed in `args`, never `$CLAUDE_PLUGIN_ROOT`.
3. **The `syntax-check.mjs` hook (`node --check`) rejects Workflow-DSL files** (top-level `return`). It must be taught about them first (Task 0), or the Write tool blocks `lib/review-workflow.mjs`. Executor node reliability (a stray old `/usr/local/bin/node` v14 can win `command node`) degrades cleanly: `preflight.mjs` already FAILs on node < 18.

---

## Task 0: Teach the `syntax-check` hook about Workflow-DSL files

**Files:**
- Modify: `.claude/hooks/syntax-check.mjs`
- Test: `tests/hooks.test.mjs` (create)

**Interfaces:**
- Consumes: hook event JSON on stdin (`{ tool_input: { file_path } }`).
- Produces: exit `0` for a syntactically valid file (workflow or normal), exit `2` for a real syntax error. Workflow-DSL files (`*-workflow.mjs`) are wrapped in an async IIFE before `node --check` so legal-in-workflow top-level `return`/`await` are not flagged.

- [ ] **Step 1: Write the failing tests**

Create `tests/hooks.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../.claude/hooks/syntax-check.mjs', import.meta.url).pathname;
const runHook = (file) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_input: { file_path: file } }), encoding: 'utf8',
});
const tmp = (name, src) => { const f = join(mkdtempSync(join(tmpdir(), 'acr-')), name); writeFileSync(f, src); return f; };

test('valid workflow-DSL file (top-level return) passes', () => {
  const f = tmp('x-workflow.mjs', `export const meta = { name: 'x' };\nphase('a');\nconst A = JSON.parse(args);\nreturn { ok: A };\n`);
  assert.equal(runHook(f).status, 0);
});

test('broken workflow-DSL file still fails', () => {
  const f = tmp('y-workflow.mjs', `export const meta = { name: 'y' };\nconst = ;\nreturn 1;\n`);
  assert.equal(runHook(f).status, 2);
});

test('normal .mjs still syntax-checked', () => {
  assert.equal(runHook(tmp('ok.mjs', 'export const a = 1;\n')).status, 0);
  assert.equal(runHook(tmp('bad.mjs', 'export const = ;\n')).status, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/hooks.test.mjs`
Expected: FAIL — the valid workflow file currently exits 2 (top-level `return`).

- [ ] **Step 3: Implement the wrap-and-check**

Replace `.claude/hooks/syntax-check.mjs` body (keep the header/`readStdin`). Replace from `const file = ...` (current line 23) to the end with:

```javascript
const file = evt?.tool_input?.file_path;
if (!file || !file.endsWith('.mjs') || !existsSync(file)) process.exit(0);

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Workflow-DSL files (lib/*-workflow.mjs) use harness globals + top-level return/await,
// which a standalone `node --check` rejects. Wrap them in an async IIFE so real syntax
// errors are still caught without false-positives on the legal-in-workflow constructs.
const src = readFileSync(file, 'utf8');
const isWorkflow = file.endsWith('-workflow.mjs') && /\bexport const meta\b/.test(src);

let target = file;
let tmpFile = null;
if (isWorkflow) {
  const wrapped = `${src.replace(/^export const meta\b/m, 'const meta')}\n`;
  tmpFile = join(tmpdir(), `acr-wfcheck-${process.pid}.mjs`);
  writeFileSync(tmpFile, `const args = '{}';\nconst phase = () => {}, log = () => {}, agent = async () => ({}), parallel = async () => [], pipeline = async () => [];\n(async () => {\n${wrapped}\n})();\n`);
  target = tmpFile;
}

try {
  execFileSync('node', ['--check', target], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (tmpFile) rmSync(tmpFile, { force: true });
  process.exit(0);
} catch (e) {
  if (tmpFile) rmSync(tmpFile, { force: true });
  const msg = (e.stderr?.toString() || e.message || 'syntax error').trim();
  process.stderr.write(`syntax-check: ${file} does not parse\n${msg}\n`);
  process.exit(2);
}
```

Move the three new imports to the top with the existing imports (do not leave `import` mid-file — the snippet shows them inline only for locality; the implementer places `readFileSync, writeFileSync, rmSync` into the existing `node:fs` import and adds `node:os`/`node:path` imports at the top).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/hooks.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .claude/hooks/syntax-check.mjs tests/hooks.test.mjs
git commit -m "fix(hooks): syntax-check Workflow-DSL files via async-IIFE wrap

node --check rejects top-level return/await in *-workflow.mjs files;
wrap them before checking so real syntax errors are still caught."
```

---

## Task 1: Harden `report.mjs`

**Files:**
- Modify: `lib/report.mjs:8` (header), `:20-22` (args), `:39` (after parse, add guards), `:76-102` (drop override branch), `:131` (simplify log)
- Test: `tests/cli.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `report.mjs` now (a) always writes to `.adverserial-code-review/review-{date}/review-{counter}[-pr-{n}]/review.{md,html}`, (b) exits `2` with a clear message when `data.plan` or `data.agentRuns` is absent, (c) no longer recognizes `--out`/`--html`. `--base-dir` and `--gate` are retained.

- [ ] **Step 1: Write the failing tests**

Add to `tests/cli.test.mjs` (follow the existing spawn style — `process.execPath`, feed stdin, assert on exit code / stdout):

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPORT = new URL('../lib/report.mjs', import.meta.url).pathname;

function runReport(payload, { cwd, args = [] } = {}) {
  return spawnSync(process.execPath, [REPORT, ...args], {
    input: JSON.stringify(payload), cwd, encoding: 'utf8',
  });
}

const validPayload = (over = {}) => ({
  findings: [], criteria: [], tier: 'standard',
  summary: 'ok', context: {},
  plan: { tier: 'standard', dimensions: ['D1'], dimensionLabels: { D1: 'Intent' },
          dimensionAgents: { D1: 'correctness-reviewer' }, models: { D1: 'sonnet' },
          runVerify: false, sharded: false, shards: [], agents: ['correctness-reviewer'] },
  agentRuns: { 'correctness-reviewer': 1 },
  ...over,
});

test('report.mjs exits 2 when plan is missing', () => {
  const { plan, ...noPlan } = validPayload();
  const r = runReport(noPlan, { cwd: mkdtempSync(join(tmpdir(), 'acr-')) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /plan/i);
});

test('report.mjs exits 2 when agentRuns is missing', () => {
  const { agentRuns, ...noRuns } = validPayload();
  const r = runReport(noRuns, { cwd: mkdtempSync(join(tmpdir(), 'acr-')) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /agentRuns/i);
});

test('report.mjs ignores --out/--html and writes the per-run folder', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acr-'));
  const r = runReport(validPayload(), { cwd, args: ['--out', 'REVIEW.md', '--html', 'REVIEW.html'] });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(cwd, 'REVIEW.md')), 'must NOT write REVIEW.md');
  const dateDirs = readdirSync(join(cwd, '.adverserial-code-review')).filter((d) => d.startsWith('review-'));
  assert.ok(dateDirs.length === 1, 'must create the per-run date folder');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/cli.test.mjs`
Expected: the three new tests FAIL (current `report.mjs` accepts `--out`/`--html` and does not throw on missing `plan`/`agentRuns`).

- [ ] **Step 3: Implement the hardening**

Edit `lib/report.mjs`:

(a) Header — replace line 8:
```javascript
// With --gate, exits with the verdict's exit code (1 on BLOCK). --base-dir relocates
// the parent of the per-run folder. There is no --out/--html: the folder + filenames
// are fixed so a review cannot be written to the wrong place.
```

(b) Args — replace lines 20-21 (delete `explicitOut`/`explicitHtml`), keep `baseDir`:
```javascript
const baseDir = arg('--base-dir', '.adverserial-code-review');
```

(c) After the `data` parse block (after current line 37), add the guards:
```javascript
if (!data.plan) {
  console.error('report.mjs: "plan" is required (the plan.mjs output) — it drives the Agents & coverage section. Refusing to write a report without it.');
  process.exit(2);
}
if (!data.agentRuns) {
  console.error('report.mjs: "agentRuns" is required (agentName → dispatch count). Refusing to write a report without it.');
  process.exit(2);
}
```

(d) Write-target block — replace the whole `let outPath, htmlPath, outDir = null; if (explicitOut && explicitHtml) {…} else {…}` (current lines 87-102) with the folder-only version:
```javascript
const dateStr = (startValid ? startedAt : finishedAt).toISOString().slice(0, 10);
const dateDir = join(baseDir, `review-${dateStr}`);
mkdirSync(dateDir, { recursive: true });
const counter = nextCounter(dateDir);              // counter is per-day, inside the date folder
const prPart = prNumber ? `-pr-${prNumber}` : '';
const outDir = join(dateDir, `review-${counter}${prPart}`);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'review.md');
const htmlPath = join(outDir, 'review.html');
```

(e) Log line — replace current line 131 (`outDir` is always set now):
```javascript
console.log(`Code review (tier: ${tier})${prNumber ? ` · PR #${prNumber}` : ''} → ${outDir}`);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/cli.test.mjs`
Expected: PASS (all, including pre-existing cli tests).

- [ ] **Step 5: Commit**

```bash
git add lib/report.mjs tests/cli.test.mjs
git commit -m "feat(report): drop --out/--html, require plan+agentRuns

Wrong report path and a missing Agents & coverage section are now
structurally impossible: the per-run folder is the only write target,
and report.mjs exits 2 if the plan or dispatch counts are absent."
```

---

## Task 2: Verify-all policy in `triage.mjs`

**Files:**
- Modify: `lib/triage.mjs:96`
- Test: `tests/triage.test.mjs`

**Interfaces:**
- Consumes: `planReview(signals, config, forceTier)` (existing).
- Produces: `plan.runVerify === true` for `low`/`standard`/`high`/`critical`; `false` only for `trivial`. The Workflow reads this to decide whether to run the Verify phase.

- [ ] **Step 1: Write the failing test**

Add to `tests/triage.test.mjs`:

```javascript
import { planReview } from '../lib/triage.mjs';

test('runVerify is on for every non-trivial tier', () => {
  for (const tier of ['low', 'standard', 'high', 'critical']) {
    const p = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, tier);
    assert.equal(p.runVerify, true, `${tier} should verify`);
  }
  const trivial = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, 'trivial');
  assert.equal(trivial.runVerify, false, 'trivial should not verify');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/triage.test.mjs`
Expected: FAIL — `low`/`standard` currently return `runVerify: false`.

- [ ] **Step 3: Implement the policy change**

Edit `lib/triage.mjs:96`:
```javascript
    runVerify: tier !== 'trivial',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/triage.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/triage.mjs tests/triage.test.mjs
git commit -m "feat(triage): verify findings on every non-trivial tier

Verify-all policy: each finding is refuted by a separate verifier agent
on low/standard/high/critical; only trivial skips verification."
```

---

## Task 3: Pure orchestration helpers (`lib/review-orchestration.mjs`)

**Files:**
- Create: `lib/review-orchestration.mjs`
- Test: `tests/review-orchestration.test.mjs`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `expandAspects(dimensionAgents: Record<dim,agent>, shards: {id,files}[]): {dim,agent,shardId,files}[]` — one aspect per (dimension × shard).
  - `findingKey(f): string` — `"<file>:<line>:<lowercased trimmed title>"` (line-sensitive; distinct from `memory.findingKey`).
  - `newCaps(): object`, `canSpawn(caps, key, max): boolean`, `recordSpawn(caps, key): void` — per-aspect dispatch counters.
  - `buildReportPayload(pieces): object` — assembles the exact `report.mjs` stdin object and **throws** if `plan` or `agentRuns` is missing (mirrors report.mjs's guard so the Workflow fails fast before spawning the report agent).

- [ ] **Step 1: Write the failing tests**

Create `tests/review-orchestration.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload } from '../lib/review-orchestration.mjs';

test('expandAspects = dimensions × shards', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ id: 'A', files: ['a.ts'] }, { id: 'B', files: ['b.ts'] }],
  );
  assert.equal(aspects.length, 4);
  assert.deepEqual(aspects[0], { dim: 'D2', agent: 'correctness-reviewer', shardId: 'A', files: ['a.ts'] });
});

test('findingKey is line-sensitive and title-normalized', () => {
  assert.equal(findingKey({ file: 'x.ts', line: 10, title: '  SQL Injection ' }), 'x.ts:10:sql injection');
  assert.notEqual(
    findingKey({ file: 'x.ts', line: 10, title: 'bug' }),
    findingKey({ file: 'x.ts', line: 11, title: 'bug' }),
  );
});

test('cap counters stop at max', () => {
  const caps = newCaps();
  assert.equal(canSpawn(caps, 'verify:x:1', 3), true);
  recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1');
  assert.equal(canSpawn(caps, 'verify:x:1', 3), false);
  assert.equal(canSpawn(caps, 'verify:x:2', 3), true);
});

test('buildReportPayload throws without plan or agentRuns', () => {
  assert.throws(() => buildReportPayload({ agentRuns: {} }), /plan/);
  assert.throws(() => buildReportPayload({ plan: {} }), /agentRuns/);
});

test('buildReportPayload assembles all fields', () => {
  const p = buildReportPayload({
    plan: { tier: 'high', gate: { block_on: ['critical'] }, learning: { store: 's' }, range: 'a..b' },
    agentRuns: { 'vuln-reviewer': 2 },
    findings: [{ severity: 'minor', file: 'a', title: 't' }],
    criteria: [{ id: 'AC1', text: 'r', covered: true }],
    strengths: ['s'], summary: 'sum', needsHuman: ['q'], skipped: ['x'],
    context: { pr: null }, verifySummary: { kept: 1 },
    startedAt: '2026-06-22T00:00:00Z', prNumber: 7, worktrees: [], commentMode: true,
  });
  assert.equal(p.tier, 'high');
  assert.equal(p.plan.tier, 'high');
  assert.equal(p.agentRuns['vuln-reviewer'], 2);
  assert.equal(p.gate.block_on[0], 'critical');
  assert.equal(p.commentMode, true);
  assert.equal(p.learningStore, 's');
  assert.equal(p.range, 'a..b');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/review-orchestration.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `lib/review-orchestration.mjs`:

```javascript
// Pure: helpers for the review Workflow (lib/review-workflow.mjs). Kept here so they
// are importable + unit-testable; the Workflow DSL file inlines copies because the
// Workflow sandbox has no module/filesystem access. Keep the two in sync.

// One review aspect per (dimension × shard). More aspects, never nested agents.
export function expandAspects(dimensionAgents = {}, shards = []) {
  const list = shards.length ? shards : [{ id: 'all', files: [] }];
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    for (const s of list) out.push({ dim, agent, shardId: s.id, files: s.files ?? [] });
  }
  return out;
}

// Line-sensitive dedup key. Deliberately NOT memory.findingKey (which is line-insensitive
// for cross-run matching) — here two same-title findings at different lines are distinct.
export function findingKey(f = {}) {
  return `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
}

// Per-aspect dispatch counters (the <=N-subagents-per-aspect cap, decided in code).
export function newCaps() { return {}; }
export function canSpawn(caps, key, max = 3) { return (caps[key] ?? 0) < max; }
export function recordSpawn(caps, key) { caps[key] = (caps[key] ?? 0) + 1; }

// Assemble the exact report.mjs stdin object. Throws if plan/agentRuns are missing so the
// Workflow fails before spawning the report agent (report.mjs enforces the same invariant).
export function buildReportPayload(pieces = {}) {
  if (!pieces.plan) throw new Error('buildReportPayload: plan is required');
  if (!pieces.agentRuns) throw new Error('buildReportPayload: agentRuns is required');
  const { plan } = pieces;
  return {
    findings: pieces.findings ?? [],
    criteria: pieces.criteria ?? [],
    tier: plan.tier,
    gate: plan.gate,
    needsHuman: pieces.needsHuman ?? [],
    skipped: pieces.skipped ?? [],
    strengths: pieces.strengths ?? [],
    summary: pieces.summary ?? '',
    context: pieces.context ?? {},
    verify: pieces.verifySummary ?? {},
    plan,
    agentRuns: pieces.agentRuns,
    commentMode: pieces.commentMode === true,
    startedAt: pieces.startedAt ?? null,
    prNumber: pieces.prNumber ?? null,
    worktrees: pieces.worktrees ?? [],
    learningStore: plan.learning?.store ?? null,
    range: plan.range ?? null,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/review-orchestration.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/review-orchestration.mjs tests/review-orchestration.test.mjs
git commit -m "feat(review): pure orchestration helpers for the Workflow

expandAspects, findingKey, per-aspect cap counters, and a
buildReportPayload that throws on missing plan/agentRuns."
```

---

## Task 4: The Workflow script (`lib/review-workflow.mjs`)

**Files:**
- Create: `lib/review-workflow.mjs`
- Verify: `node --check` parse + a `meta` shape assertion (no live-agent unit test is possible)

**Interfaces:**
- Consumes (`args`): `{ plan, bundle, diff, shards, routing, flags, startedAt, prNumber, worktrees }` (all produced by the main agent in Task 5). `routing = { scrutiny: {targets:[…]}, checks: {checks:[…]} }` from `route.mjs`.
- Produces (return): `{ folderPath, gate, needsHuman, notes }`. Spawns the report agent which writes the per-run folder.

> **Note for the implementer:** this is a Workflow-DSL file, NOT a runnable pipeline-step module. It has no shebang and no `main`; its top-level body uses the harness globals `agent`/`pipeline`/`parallel`/`phase`/`log`/`args`. It cannot be `import`ed or run with `node`, so it inlines the Task-3 helpers (the canonical, tested copies live in `lib/review-orchestration.mjs` — keep them in sync). Verification is a parse check, not a unit test.

- [ ] **Step 1: Write the Workflow script**

Create `lib/review-workflow.mjs`:

```javascript
export const meta = {
  name: 'acr-review',
  description: 'Adversarial code review fan-out: intent, per-aspect review, per-finding verify, synthesize, render.',
  phases: [
    { title: 'Intent' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
    { title: 'Report' },
  ],
};

// --- inlined pure helpers (canonical + tested: lib/review-orchestration.mjs) ---
const findingKey = (f = {}) => `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
function expandAspects(dimensionAgents = {}, shards = []) {
  const list = shards.length ? shards : [{ id: 'all', files: [] }];
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    for (const s of list) out.push({ dim, agent, shardId: s.id, files: s.files ?? [] });
  }
  return out;
}
const newCaps = () => ({});
const canSpawn = (caps, key, max = 3) => (caps[key] ?? 0) < max;
const recordSpawn = (caps, key) => { caps[key] = (caps[key] ?? 0) + 1; };

// --- schemas (force structured sub-agent output) ---
const FINDING = {
  type: 'object',
  properties: {
    dimension: { type: 'string' }, severity: { enum: ['critical', 'important', 'minor', 'suggestion'] },
    file: { type: 'string' }, line: { type: 'number' }, title: { type: 'string' },
    evidence: { type: 'string' }, fix: { type: 'string' }, confidence: { type: 'number' },
    uncertain: { type: 'boolean' },
  },
  required: ['severity', 'file', 'title'],
};
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: { strengths: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: FINDING } },
  required: ['findings'],
};
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['real', 'refuted', 'uncertain'] }, lens: { type: 'string' },
    rationale: { type: 'string' }, confidence: { type: 'number' },
  },
  required: ['verdict'],
};
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, strengths: { type: 'array', items: { type: 'string' } },
    criteria: { type: 'array' }, findings: { type: 'array', items: FINDING },
    needsHuman: { type: 'array' }, skipped: { type: 'array' },
  },
  required: ['findings'],
};

// args arrives as a JSON STRING (confirmed via spike), not a parsed object — parse defensively.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
const { lib, plan, bundle, diff, shards, routing, flags, startedAt, prNumber, worktrees } = A;
const notes = [];
const agentRuns = {};
const caps = newCaps();
const bump = (name) => { agentRuns[name] = (agentRuns[name] ?? 0) + 1; };

// reviewer packet: NEVER includes this chat's history
const basePacket = {
  summary: bundle?.summary ?? '',
  projectRules: plan.projectRules ?? [],
};

// ---------------------------------------------------------------- Intent
phase('Intent');
const harvester = await agent(
  `Build the acceptance-criteria model for this change. Context: ${JSON.stringify(basePacket)}. Diff summary: ${plan.diffSummary}. Diff:\n${diff}`,
  { agentType: 'intent-harvester', phase: 'Intent' },
).then((r) => (bump('intent-harvester'), r));

const [grouper, businessLogic] = await parallel([
  () => agent(
    `Cluster this diff into intent groups (primary vs EXTRA), flag groups needing scrutiny. Criteria: ${JSON.stringify(harvester)}. Diff:\n${diff}`,
    { agentType: 'intent-grouper', phase: 'Intent' },
  ).then((r) => (bump('intent-grouper'), r)),
  () => (plan.tier === 'low'
    ? Promise.resolve(null)
    : agent(
      `Model the domain/business logic; list assumptions + OPEN QUESTIONS (do not guess on material ambiguity). Criteria: ${JSON.stringify(harvester)}. Diff:\n${diff}`,
      { agentType: 'business-logic-analyzer', phase: 'Intent' },
    ).then((r) => (bump('business-logic-analyzer'), r))),
]);

// ---------------------------------------------------------------- Review → Verify (pipeline, no barrier)
phase('Review');
const aspects = expandAspects(plan.dimensionAgents, shards);
// extra-intent scrutiny + mandatory checks become additional aspects (computed in the main agent via route.mjs)
for (const t of routing?.scrutiny?.targets ?? []) aspects.push({ dim: t.label, agent: 'correctness-reviewer', shardId: 'scrutiny', files: t.files });

const reviewed = await pipeline(
  aspects,
  // stage 1: review one aspect
  (a) => agent(
    `Review ONLY these changed files for dimension ${a.dim}: ${JSON.stringify(a.files)}. ` +
    `Acceptance criteria + mismatches: ${JSON.stringify(harvester)}. Relevant intent groups: ${JSON.stringify(grouper)}. ` +
    `Project rules: ${JSON.stringify(plan.projectRules)}. Diff:\n${diff}`,
    { agentType: a.agent, model: plan.models?.[a.dim], label: `review:${a.dim}:${a.shardId}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => { bump(a.agent); return { aspect: a, findings: r?.findings ?? [], strengths: r?.strengths ?? [] }; })
    .catch((e) => { notes.push(`review ${a.dim}/${a.shardId} failed: ${e.message}`); return null; }),
  // stage 2: verify EVERY finding from this aspect, each in its own agent (verify-all)
  (rev) => {
    if (!rev || !plan.runVerify) return rev;
    return parallel(rev.findings.map((f) => () => {
      const key = `verify:${findingKey(f)}`;
      if (!canSpawn(caps, key, plan.verify?.maxSubagentsPerAspect ?? 3)) return Promise.resolve({ ...f, verdict: { verdict: 'uncertain', lens: 'capped' } });
      recordSpawn(caps, key);
      const isSecurity = (f.dimension === 'D3') && plan.discovery?.taint;
      const verifier = isSecurity ? 'taint-verifier' : 'finding-verifier';
      return agent(
        `Adversarially REFUTE this finding by reading the actual code path. Finding: ${JSON.stringify(f)}. Diff:\n${diff}`,
        { agentType: verifier, label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => { bump(verifier); return { ...f, verdict: v }; })
        .catch((e) => { notes.push(`verify ${f.file}:${f.line} failed: ${e.message}`); return { ...f, verdict: { verdict: 'uncertain', lens: 'error' } }; });
    })).then((verified) => ({ ...rev, findings: verified }));
  },
);

const allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings);
const allStrengths = reviewed.filter(Boolean).flatMap((r) => r.strengths ?? []);

// ---------------------------------------------------------------- Resolve (deterministic script via executor agent)
phase('Synthesize');
const resolveInput = JSON.stringify({
  findings: allFindings.map((f) => ({ ...f, verdicts: f.verdict ? [{ verdict: f.verdict.verdict, lens: f.verdict.lens }] : [] })),
  config: { verify: plan.verify },
});
const resolved = await agent(
  `Run this EXACT command from the repo root and return ONLY its stdout JSON, nothing else:\n` +
  `cat <<'ACR_EOF' | node "${lib}/verify.mjs" resolve\n${resolveInput}\nACR_EOF`,
  { agentType: 'general-purpose', label: 'resolve', phase: 'Synthesize', schema: { type: 'object', properties: { report: { type: 'array' }, dropped: { type: 'array' }, needsHuman: { type: 'array' }, summary: { type: 'object' } }, required: ['report'] } },
).catch((e) => { notes.push(`resolve failed: ${e.message}`); return { report: allFindings, dropped: [], needsHuman: [], summary: {} }; });

// ---------------------------------------------------------------- Synthesize
const synth = await agent(
  `Aggregate into one deduped, severity-ranked review with a per-criterion traceability matrix. ` +
  `Acceptance criteria: ${JSON.stringify(harvester)}. Kept findings: ${JSON.stringify(resolved.report)}. ` +
  `Strengths seen: ${JSON.stringify(allStrengths)}. Business-logic open questions: ${JSON.stringify(businessLogic)}.`,
  { agentType: 'review-synthesizer', phase: 'Synthesize', schema: SYNTH_SCHEMA },
).then((r) => (bump('review-synthesizer'), r));

if (flags?.comment) {
  await agent(`Turn these kept findings into inline PR comment objects: ${JSON.stringify(synth.findings)}`,
    { agentType: 'pr-comment-author', phase: 'Synthesize' }).then(() => bump('pr-comment-author')).catch((e) => notes.push(`pr-comment-author failed: ${e.message}`));
}

// ---------------------------------------------------------------- Report (deterministic script via executor agent)
phase('Report');
const payload = {
  findings: synth.findings ?? [],
  criteria: synth.criteria ?? [],
  tier: plan.tier, gate: plan.gate,
  needsHuman: [...(synth.needsHuman ?? []), ...(resolved.needsHuman ?? [])],
  skipped: synth.skipped ?? [], strengths: synth.strengths ?? [], summary: synth.summary ?? '',
  context: { pr: bundle?.pr, tickets: bundle?.tickets, existingComments: bundle?.existingComments, trackerUsage: bundle?.trackerUsage },
  verify: resolved.summary ?? {},
  plan, agentRuns,
  commentMode: flags?.comment === true,
  startedAt: startedAt ?? null, prNumber: prNumber ?? null, worktrees: worktrees ?? [],
  learningStore: plan.learning?.store ?? null, range: plan.range ?? null,
};
const reportOut = await agent(
  `Run this EXACT command from the repo root and return ONLY the folder path it prints after the arrow:\n` +
  `cat <<'ACR_EOF' | node "${lib}/report.mjs"${flags?.gate ? ' --gate' : ''}\n${JSON.stringify(payload)}\nACR_EOF`,
  { agentType: 'general-purpose', label: 'report', phase: 'Report', schema: { type: 'object', properties: { folderPath: { type: 'string' }, verdict: { type: 'string' } }, required: ['folderPath'] } },
).catch((e) => { notes.push(`report failed: ${e.message}`); return { folderPath: null, verdict: 'ERROR' }; });

return { folderPath: reportOut.folderPath, gate: reportOut.verdict, needsHuman: payload.needsHuman, notes };
```

- [ ] **Step 2: Verify it parses (via the Task-0 wrap, NOT bare `node --check`)**

Bare `node --check lib/review-workflow.mjs` FAILS (top-level `return`) — that is expected. The Task-0 hook validates it on Write by wrapping in an async IIFE. To verify manually, run the same wrap:

Run:
```bash
node -e "const fs=require('fs'),os=require('os'),p=require('path'),{execFileSync}=require('child_process');const s=fs.readFileSync('lib/review-workflow.mjs','utf8').replace(/^export const meta\b/m,'const meta');const t=p.join(os.tmpdir(),'wfck.mjs');fs.writeFileSync(t,'const args=\"{}\";const phase=()=>{},log=()=>{},agent=async()=>({}),parallel=async()=>[],pipeline=async()=>[];(async()=>{'+s+'})();');execFileSync('node',['--check',t]);console.log('parse OK')"
```
Expected: `parse OK`. (If the Write tool's hook accepted the file, it already passed this same check.)

- [ ] **Step 3: Assert the meta shape with a tiny test**

Add to `tests/review-orchestration.test.mjs`:

```javascript
import { readFileSync } from 'node:fs';
test('review-workflow.mjs declares a valid meta with 5 phases', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const meta = \{/);
  for (const p of ['Intent', 'Review', 'Verify', 'Synthesize', 'Report']) {
    assert.ok(src.includes(`title: '${p}'`), `meta must list phase ${p}`);
  }
  // inlined helpers must match the canonical signatures
  assert.match(src, /function expandAspects\(/);
  assert.match(src, /const findingKey =/);
});
```

- [ ] **Step 4: Run tests + parse check**

Run: `node --test tests/review-orchestration.test.mjs` (and the wrap-check from Step 2)
Expected: parse OK; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/review-workflow.mjs tests/review-orchestration.test.mjs
git commit -m "feat(review): deterministic Workflow for review fan-out + verify-all

Intent -> per-aspect review (dims x shards) -> per-finding verify in a
separate agent -> resolve/synthesize -> render. agentRuns counted in JS;
report runs via executor agent so the main agent stays a dispatcher."
```

---

## Task 5: Thin `commands/review.md`

**Files:**
- Modify: `commands/review.md` (replace body; keep the frontmatter `description`)
- Verify: read-through against the spec's §7; no automated test (it is a prompt)

**Interfaces:**
- Consumes: `lib/preflight.mjs`, `lib/worktree.mjs`, `lib/plan.mjs`, `lib/gather.mjs`, `lib/scan.mjs`, `lib/route.mjs`, `lib/memory.mjs`, `lib/review-workflow.mjs`, `lib/comments.mjs`.
- Produces: the user-facing `/review` behavior.

- [ ] **Step 1: Replace the command body**

Replace everything in `commands/review.md` **after the frontmatter** (keep lines 1-3, the `---`/description/`---`) with:

````markdown
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
````

- [ ] **Step 2: Verify the invariants survived the rewrite**

Run:
```bash
grep -c "command node" commands/review.md   # expect 0 (bare node only)
grep -c 'node "\$LIB' commands/review.md      # expect >= 6 (bare node invocations)
grep -c -- "--out" commands/review.md         # expect 0 (no path override)
```
Expected: zero `command node`, bare `node "$LIB` present (>= 6), zero `--out`.

- [ ] **Step 3: Run the full test suite (nothing regressed)**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add commands/review.md
git commit -m "feat(review): thin /review command that delegates to the Workflow

Main agent now runs deterministic scripts + one Workflow call; the
125-line prose orchestration is gone. No --out path override survives."
```

---

## Task 6: Docs + convention note

**Files:**
- Modify: `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
- Verify: `check-versions` hook (run by the suite/commit) stays green; read-through

- [ ] **Step 1: Update `CLAUDE.md` — module-convention exception + where things live**

Under the `## Module convention (lib/*.mjs)` section, add a bullet:
```markdown
- **Workflow-DSL exception**: `lib/review-workflow.mjs` is NOT a pipeline-step module — it has no shebang/`main` and uses the harness Workflow globals (`agent`/`pipeline`/`phase`/`args`). It cannot be `import`ed or run with `node`; it inlines the pure helpers whose canonical, tested copies live in `lib/review-orchestration.mjs`. Keep the two in sync.
```
Under `## Where things live`, add:
```markdown
- **Review orchestration** is a Workflow (`lib/review-workflow.mjs`), invoked by `commands/review.md`. The main agent only runs the deterministic scripts + the Workflow call; it never assembles the `report.mjs` payload by hand.
```

- [ ] **Step 2: Update `README.md` + `docs/ARCHITECTURE.md`**

Run `/sync-docs` and apply its mapping. At minimum:
- Describe `/review` as a thin dispatcher + Workflow fan-out (replace any text implying the main agent orchestrates step-by-step).
- State the verify-all policy (every finding verified by a separate agent on non-trivial tiers).
- State the report guarantee: always the per-run folder; the "Agents & coverage" (Ran / Did not run) section is always present; `report.mjs` has no `--out`/`--html`.

- [ ] **Step 3: Run the full suite + version check**

Run: `npm test`
Expected: PASS, and the `check-versions` hook reports no drift (no version bump in this plan).

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ARCHITECTURE.md CLAUDE.md
git commit -m "docs: document Workflow-based /review + verify-all + report guarantees"
```

---

## Self-Review

**Spec coverage:**
- Thin main agent → Task 5. ✓
- Workflow fan-out (intent/review/verify/synth/report) → Task 4. ✓
- Verify-every-finding in a separate agent → Task 4 stage 2 + Task 2 (`runVerify`). ✓
- Sharding = dimensions × shards aspects → Task 3 `expandAspects` + Task 4. ✓
- Payload built deterministically, `agentRuns` counted in JS → Task 4 + Task 3 `buildReportPayload`. ✓
- `report.mjs` hardened (no `--out`/`--html`, throws on missing plan/agentRuns) → Task 1. ✓
- Scripts (resolve/report) run via separate executor agents → Task 4. ✓
- Per-aspect caps as JS counters → Task 3 `newCaps/canSpawn/recordSpawn` + Task 4. ✓
- Degrade-never-crash (`notes[]`, `.catch`/`.filter(Boolean)`) → Task 4. ✓
- Docs + module-convention exception → Task 6. ✓
- `command node` everywhere → Tasks 4 (executor prompts) + 5. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code; every command has expected output.

**Type consistency:** `findingKey`, `expandAspects`, `newCaps`/`canSpawn`/`recordSpawn`, `buildReportPayload` signatures match between Task 3 (canonical) and Task 4 (inlined). `agentRuns` is a `name→count` map throughout. The Workflow return `{ folderPath, gate, needsHuman, notes }` matches what Task 5 step 4 consumes.

**Known limitation (called out, not a gap):** Task 4's orchestration body cannot be unit-tested (no live agents in `node --test`); it is covered by a parse check + meta-shape test, with its logic factored into the unit-tested `lib/review-orchestration.mjs`. The correctness *guarantee* (right folder, coverage section present) is enforced and tested in Task 1 (`report.mjs`), independent of the Workflow.
