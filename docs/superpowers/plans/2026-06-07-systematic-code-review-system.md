# Systematic Code Review System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an advisory, criticality-aware code-review system that understands a change's intent, scales review depth to risk, and delivers verified findings as PR comments / a report / a gate.

**Architecture:** A deterministic orchestrator (Claude Code Workflow script) drives an 8-phase pipeline — intake → intent → criteria → triage → fan-out review → adversarial verify → synthesize+gate → deliver. A cheap `triage-classifier` picks the dimension set, depth, and model tier per change so trivial changes get a tiny review and critical-path changes get adversarial depth. Existing reviewer skills become on-demand knowledge packs; duplicated agents are merged. The system never edits code — advisory only.

**Tech Stack:** Claude Code agents (`.claude/agents/*.md`), skills (`.claude/skills/*/SKILL.md`), commands (`.claude/commands/*.md`), a Workflow orchestrator script (`.claude/workflows/code-review.js`, plain JS), `gh` CLI for PR comments, git for diffs, a YAML project config, JSON fixtures as the test oracle.

**Source spec:** `docs/superpowers/specs/2026-06-07-systematic-code-review-system-design.md`

---

## Phasing

- **Phase 1 (this plan, fully detailed):** the brain + a working Standard-tier reviewer end-to-end. Milestones M0–M6. Ships a usable `/review`.
- **Phase 2 (follow-on plan):** adversarial verify, all remaining dimensions (D7/D9/D10/D14/D15/D17), incremental re-review. Plan file: `docs/superpowers/plans/2026-NN-NN-review-system-phase2-depth.md`.
- **Phase 3 (follow-on plan):** pre-push hook + GitHub Action CI + ClickUp/Jira intent connectors. Plan file: `docs/superpowers/plans/2026-NN-NN-review-system-phase3-automation.md`.

---

## File Structure (Phase 1)

| Path | Responsibility |
|------|----------------|
| `.review/config.schema.json` | JSON Schema for the per-project review config (risk-map, mandatory checks, gate). |
| `.review/config.yml` | The project's own review config (dogfood). |
| `.claude/workflows/lib/signals.js` | Pure function: parse a git diff + metadata into triage signals. |
| `.claude/workflows/lib/triage.js` | Pure function: signals + config → review plan {tier, dimensions, depth, models}. |
| `.claude/workflows/lib/render.js` | Pure functions: findings → REVIEW.md, → terminal summary, → verdict/exit-code. |
| `.claude/workflows/code-review.js` | Orchestrator Workflow script wiring the 8 phases. |
| `.claude/agents/triage-classifier.md` | Thin agent: confirm/adjust the computed tier with judgment (haiku). |
| `.claude/agents/intent-harvester.md` | Pull PR body + commits + rules files → acceptance-criteria model (sonnet). |
| `.claude/agents/correctness-reviewer.md` | Merged D1/D2/D12 reviewer (sonnet). |
| `.claude/agents/review-synthesizer.md` | Dedupe + severity rollup + traceability + verdict (sonnet). |
| `.claude/commands/review.md` | `/review` entry point; flags; invokes the workflow. |
| `.claude/commands/review-config.md` | Scaffold/edit `.review/config.yml`. |
| `fixtures/cases/*.json` | Test oracle: `{name, files[], diff, expectedTier, expectedDimensions}`. |
| `tests/triage.test.mjs` | Node test runner asserting `signals.js`+`triage.js` against fixtures. |
| `tests/render.test.mjs` | Node test runner asserting `render.js` output shapes. |
| `docs/CODE-REVIEW.md` | User-facing usage doc. |

Reused-as-pack (Phase 1 references these global skills by path; no copy): `security-review`, `coding-standards`, `java-coding-standards`, `jpa-patterns`, `tdd-workflow`, `api-design`, `backend-patterns`.

Reused-as-agent (wired in Phase 1 orchestrator, already exist globally): `silent-failure-hunter`, `pr-test-analyzer`, `database-reviewer`, `security-reviewer`, `comment-analyzer`.

---

## Conventions

- **Test runner:** Node's built-in `node:test` + `node:assert` (no new deps). Run with `node --test`.
- **Pure logic is unit-tested** (signals/triage/render). **Agent behavior is validated** by dry-running the workflow on a fixture and asserting the printed review plan (not by mocking the model).
- **TDD:** write the failing test, see it fail, implement minimal, see it pass, commit.
- **Commits:** one per task, conventional-commit prefix.

---

### Task 0: Repo scaffolding

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agentic-code-review",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
```

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
REVIEW.md
.review/cache/
*.log
```

- [ ] **Step 3: Verify Node test runner works**

Run: `node --test`
Expected: exits 0 with "tests 0" (no tests yet) — confirms the runner is available.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold agentic-code-review package"
```

---

### Task 1: Triage signals (pure function)

**Files:**
- Create: `.claude/workflows/lib/signals.js`
- Test: `tests/triage.test.mjs`
- Create fixtures: `fixtures/cases/typo.json`, `fixtures/cases/payment.json`, `fixtures/cases/feature.json`

- [ ] **Step 1: Write the three fixtures**

`fixtures/cases/typo.json`:
```json
{
  "name": "doc typo",
  "files": ["README.md"],
  "netLoc": 1,
  "diff": "--- a/README.md\n+++ b/README.md\n@@\n-teh\n+the\n",
  "depsChanged": false,
  "testsPresent": false,
  "concurrencyTouched": false,
  "publicContract": false,
  "expectedTier": "trivial",
  "expectedDimensions": ["D2", "D13"]
}
```

`fixtures/cases/payment.json`:
```json
{
  "name": "payment capture change",
  "files": ["src/payment/CaptureService.java"],
  "netLoc": 60,
  "diff": "diff --git a/src/payment/CaptureService.java ...",
  "depsChanged": false,
  "testsPresent": true,
  "concurrencyTouched": true,
  "publicContract": false,
  "expectedTier": "critical",
  "expectedDimensions": ["D1","D2","D3","D4","D5","D6","D7","D8","D12","D14"]
}
```

`fixtures/cases/feature.json`:
```json
{
  "name": "normal feature",
  "files": ["src/profile/profileService.ts", "src/profile/profileService.test.ts"],
  "netLoc": 90,
  "diff": "diff --git a/src/profile/profileService.ts ...",
  "depsChanged": false,
  "testsPresent": true,
  "concurrencyTouched": false,
  "publicContract": false,
  "expectedTier": "standard",
  "expectedDimensions": ["D1","D2","D4","D5","D12","D16"]
}
```

- [ ] **Step 2: Write the failing test**

`tests/triage.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { computeSignals } from '../.claude/workflows/lib/signals.js';

const dir = new URL('../fixtures/cases/', import.meta.url);
const cases = readdirSync(dir).map(f => JSON.parse(readFileSync(new URL(f, dir))));

test('computeSignals flags payment path as risky', () => {
  const pay = cases.find(c => c.name === 'payment capture change');
  const s = computeSignals(pay);
  assert.equal(s.riskPaths.includes('payment'), true);
  assert.equal(s.concurrencyTouched, true);
});

test('computeSignals flags trivial doc-only change', () => {
  const t = cases.find(c => c.name === 'doc typo');
  const s = computeSignals(t);
  assert.equal(s.docOnly, true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/triage.test.mjs`
Expected: FAIL — "Cannot find module .../signals.js".

- [ ] **Step 4: Implement `signals.js`**

```js
// Pure: derive cheap classification signals from diff metadata.
const RISK_PATTERNS = [
  ['auth', /(^|\/)auth(\/|\.|$)/i],
  ['payment', /(^|\/)(payment|billing|checkout)(\/|\.|$)/i],
  ['migration', /migration|\.sql$|flyway|liquibase/i],
  ['crypto', /crypto|cipher|encrypt|signature/i],
  ['infra', /(^|\/)(infra|deploy)\/|Dockerfile|\.tf$|\.ya?ml$/i],
  ['secrets', /secret|credential|\.env/i],
];
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;

export function computeSignals(change) {
  const files = change.files ?? [];
  const riskPaths = RISK_PATTERNS
    .filter(([, re]) => files.some(f => re.test(f)))
    .map(([name]) => name);
  return {
    fileCount: files.length,
    netLoc: change.netLoc ?? 0,
    docOnly: files.length > 0 && files.every(f => DOC_EXT.test(f)),
    riskPaths,
    publicContract: !!change.publicContract,
    depsChanged: !!change.depsChanged,
    testsPresent: !!change.testsPresent,
    concurrencyTouched: !!change.concurrencyTouched,
    languages: [...new Set(files.map(extLang).filter(Boolean))],
  };
}

function extLang(f) {
  if (/\.java$/.test(f)) return 'java';
  if (/\.(ts|tsx|js|jsx)$/.test(f)) return 'ts';
  if (/\.py$/.test(f)) return 'python';
  if (/\.sql$/.test(f)) return 'sql';
  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/triage.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add .claude/workflows/lib/signals.js tests/triage.test.mjs fixtures/cases/
git commit -m "feat: triage signal extraction from diff metadata"
```

---

### Task 2: Triage tiering + dimension selection (pure function)

**Files:**
- Create: `.claude/workflows/lib/triage.js`
- Modify: `tests/triage.test.mjs` (append)

- [ ] **Step 1: Append failing tests**

Add to `tests/triage.test.mjs`:
```js
import { planReview } from '../.claude/workflows/lib/triage.js';

const DEFAULT_CFG = { risk_map: {}, mandatory_checks: [], gate: { block_on: ['critical'], warn_on: ['high'] } };

test('trivial doc change → trivial tier, minimal dimensions', () => {
  const t = cases.find(c => c.name === 'doc typo');
  const plan = planReview(computeSignals(t), DEFAULT_CFG);
  assert.equal(plan.tier, 'trivial');
  assert.deepEqual(plan.dimensions.sort(), ['D13','D2']);
  assert.equal(plan.runVerify, false);
});

test('payment change → critical tier, security+concurrency mandatory, verify on', () => {
  const p = cases.find(c => c.name === 'payment capture change');
  const plan = planReview(computeSignals(p), DEFAULT_CFG);
  assert.equal(plan.tier, 'critical');
  assert.ok(plan.dimensions.includes('D3'));
  assert.ok(plan.dimensions.includes('D7'));
  assert.equal(plan.runVerify, true);
  assert.equal(plan.models.D3, 'opus');
});

test('normal feature → standard tier, simplifier suggestions, no verify', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const plan = planReview(computeSignals(f), DEFAULT_CFG);
  assert.equal(plan.tier, 'standard');
  assert.ok(plan.dimensions.includes('D16'));
  assert.equal(plan.runVerify, false);
});

test('risk_map config can force a tier floor', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const cfg = { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } };
  const plan = planReview(computeSignals(f), cfg);
  assert.equal(plan.tier, 'critical');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/triage.test.mjs`
Expected: FAIL — "Cannot find module .../triage.js".

- [ ] **Step 3: Implement `triage.js`**

```js
// Pure: signals + config → review plan. No I/O, no model calls.
import { minimatch } from 'node:path'; // placeholder; see Step 3b for glob

const TIER_ORDER = ['trivial', 'low', 'standard', 'high', 'critical'];

const TIER_DIMENSIONS = {
  trivial:  ['D2', 'D13'],
  low:      ['D1', 'D2', 'D5', 'D16'],
  standard: ['D1', 'D2', 'D4', 'D5', 'D12', 'D16'],
  high:     ['D1','D2','D4','D5','D10','D11','D12','D16'],
  critical: ['D1','D2','D3','D4','D5','D6','D7','D8','D12','D14'],
};

const OPUS_DIMS = new Set(['D3', 'D7', 'D9']);

export function planReview(signals, config) {
  let tier = baseTier(signals);
  tier = applyRiskMap(tier, signals, config);

  const dims = new Set(TIER_DIMENSIONS[tier]);
  // content-gated additions
  if (signals.depsChanged) dims.add('D15');
  if (signals.publicContract) dims.add('D10');
  if (signals.riskPaths.includes('migration')) dims.add('D6');
  if (signals.concurrencyTouched) dims.add('D7');
  if (signals.languages.includes('java') || signals.languages.includes('sql')) dims.add('D6');

  const models = {};
  for (const d of dims) models[d] = OPUS_DIMS.has(d) ? 'opus' : tierModel(tier);

  return {
    tier,
    dimensions: [...dims],
    models,
    runVerify: tier === 'high' || tier === 'critical',
    mandatoryChecks: config.mandatory_checks ?? [],
    gate: config.gate ?? { block_on: ['critical'], warn_on: ['high'] },
  };
}

function baseTier(s) {
  if (s.docOnly) return 'trivial';
  const hot = s.riskPaths.length > 0 || s.publicContract || s.concurrencyTouched;
  if (hot) return 'critical';
  if (s.fileCount <= 3 && s.netLoc <= 40 && s.testsPresent) return 'low';
  return 'standard';
}

function tierModel(tier) {
  return tier === 'trivial' ? 'haiku' : 'sonnet';
}

function applyRiskMap(tier, signals, config) {
  const map = config.risk_map ?? {};
  for (const forced of ['critical', 'high']) {
    const globs = map[forced] ?? [];
    if (globs.some(g => signals.__files?.some?.(f => globMatch(g, f)))) {
      return higher(tier, forced);
    }
  }
  return tier;
}

function higher(a, b) {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}
```

- [ ] **Step 3b: Add a tiny glob matcher + thread files through signals**

In `signals.js`, add `__files: files` to the returned object (so triage can glob-match). In `triage.js`, replace the `minimatch` import with a local matcher:

```js
// remove the node:path import line; add:
function globMatch(glob, file) {
  const re = new RegExp(
    '^' + glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*') + '$'
  );
  return re.test(file);
}
```

Update `computeSignals` return to include `__files: files`.

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/triage.test.mjs`
Expected: PASS (all triage tests, including risk_map floor).

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/lib/triage.js .claude/workflows/lib/signals.js tests/triage.test.mjs
git commit -m "feat: criticality tiering and dimension selection"
```

---

### Task 3: Renderers — REVIEW.md, terminal, verdict (pure functions)

**Files:**
- Create: `.claude/workflows/lib/render.js`
- Test: `tests/render.test.mjs`

- [ ] **Step 1: Write the failing test**

`tests/render.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, renderVerdict } from '../.claude/workflows/lib/render.js';

const findings = [
  { dimension: 'D3', severity: 'critical', file: 'src/auth.ts', line: 42, title: 'Missing authz', confidence: 95, evidence: 'no role check', fix: 'add requirePermission' },
  { dimension: 'D2', severity: 'minor', file: 'src/util.ts', line: 7, title: 'Magic number', confidence: 82, evidence: '', fix: 'name the constant' },
];
const criteria = [{ id: 'AC1', text: 'only admins can delete', covered: true, evidence: 'auth.test.ts:10' }];

test('verdict blocks on critical', () => {
  const v = renderVerdict(findings, { block_on: ['critical'], warn_on: ['high'] });
  assert.equal(v.verdict, 'BLOCK');
  assert.equal(v.exitCode, 1);
});

test('report groups by severity and includes traceability matrix', () => {
  const md = renderReport({ findings, criteria, tier: 'critical' });
  assert.match(md, /## Critical/);
  assert.match(md, /Missing authz/);
  assert.match(md, /AC1/);
  assert.match(md, /only admins can delete/);
});

test('only confidence>=80 findings are rendered', () => {
  const noisy = [...findings, { dimension: 'D2', severity: 'minor', file: 'x', line: 1, title: 'low conf', confidence: 50 }];
  const md = renderReport({ findings: noisy, criteria, tier: 'standard' });
  assert.doesNotMatch(md, /low conf/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/render.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `render.js`**

```js
const SEV_ORDER = ['critical', 'high', 'important', 'minor', 'suggestion'];
const MIN_CONFIDENCE = 80;

export function renderVerdict(findings, gate) {
  const present = new Set(findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE).map(f => f.severity));
  const blocks = (gate.block_on ?? ['critical']).some(s => present.has(s));
  const warns = (gate.warn_on ?? ['high']).some(s => present.has(s));
  if (blocks) return { verdict: 'BLOCK', exitCode: 1 };
  if (warns) return { verdict: 'WARN', exitCode: 0 };
  return { verdict: 'APPROVE', exitCode: 0 };
}

export function renderReport({ findings, criteria, tier }) {
  const kept = findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const lines = [`# Code Review (tier: ${tier})`, ''];

  lines.push('## Requirement Traceability', '');
  for (const c of criteria ?? []) {
    lines.push(`- ${c.covered ? 'x' : ' '} **${c.id}** ${c.text}${c.evidence ? ` — _${c.evidence}_` : ''}`.replace(/^- /, c.covered ? '- [x] ' : '- [ ] '));
  }
  lines.push('');

  for (const sev of SEV_ORDER) {
    const group = kept.filter(f => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${cap(sev)}`, '');
    for (const f of group) {
      lines.push(`- **${f.title}** (${f.dimension}) — \`${f.file}:${f.line}\` _(conf ${f.confidence})_`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    }
    lines.push('');
  }
  const { verdict } = renderVerdict(findings, { block_on: ['critical'], warn_on: ['high'] });
  lines.push(`## Verdict: ${verdict}`);
  return lines.join('\n');
}

const cap = s => s[0].toUpperCase() + s.slice(1);
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test tests/render.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add .claude/workflows/lib/render.js tests/render.test.mjs
git commit -m "feat: report, traceability matrix, and verdict renderers"
```

---

### Task 4: Config schema + project config

**Files:**
- Create: `.review/config.schema.json`
- Create: `.review/config.yml`
- Modify: `tests/triage.test.mjs` (append a config-load assertion is unnecessary; schema is doc-time) — instead add a validation test below.
- Create: `tests/config.test.mjs`

- [ ] **Step 1: Write the schema**

`.review/config.schema.json`:
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "risk_map": {
      "type": "object",
      "properties": {
        "critical": { "type": "array", "items": { "type": "string" } },
        "high": { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": false
    },
    "mandatory_checks": { "type": "array", "items": { "type": "string" } },
    "project_rules": { "type": "array", "items": { "type": "string" } },
    "intent_sources": {
      "type": "object",
      "properties": {
        "pr": { "type": "boolean" }, "commits": { "type": "boolean" },
        "clickup": { "type": "boolean" }, "jira": { "type": "boolean" }
      },
      "additionalProperties": false
    },
    "gate": {
      "type": "object",
      "properties": {
        "block_on": { "type": "array", "items": { "type": "string" } },
        "warn_on": { "type": "array", "items": { "type": "string" } }
      },
      "additionalProperties": false
    },
    "knowledge_packs": { "type": "object" }
  }
}
```

- [ ] **Step 2: Write the project config (dogfood)**

`.review/config.yml`:
```yaml
risk_map:
  critical: [".claude/workflows/**", ".review/**"]
  high: [".claude/agents/**", ".claude/commands/**"]
mandatory_checks:
  - "no secrets or tokens committed"
  - "pure lib functions have unit tests"
project_rules: ["CLAUDE.md", "docs/superpowers/specs/2026-06-07-systematic-code-review-system-design.md"]
intent_sources: { pr: true, commits: true, clickup: false, jira: false }
gate: { block_on: ["critical"], warn_on: ["high"] }
```

- [ ] **Step 3: Write the failing schema-validation test**

`tests/config.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// minimal: assert the yaml parses and required top-level keys are present.
import { parse } from 'yaml'; // if unavailable, see Step 4 fallback

test('project config parses and has a gate', () => {
  const cfg = parse(readFileSync('.review/config.yml', 'utf8'));
  assert.ok(cfg.gate.block_on.includes('critical'));
  assert.ok(Array.isArray(cfg.risk_map.critical));
});
```

- [ ] **Step 4: Run; if `yaml` missing, add a tiny loader instead**

Run: `node --test tests/config.test.mjs`
If it fails with "Cannot find package 'yaml'": create `.claude/workflows/lib/loadConfig.js` using a minimal YAML subset parser is risky — instead add the dep:
```bash
npm pkg set dependencies.yaml="^2.4.0" && npm install
```
Re-run. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .review/ tests/config.test.mjs package.json package-lock.json
git commit -m "feat: review config schema and dogfood project config"
```

---

### Task 5: `triage-classifier` agent (judgment layer over computed plan)

**Files:**
- Create: `.claude/agents/triage-classifier.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: triage-classifier
description: Confirms or adjusts the computed review tier for a change using judgment about blast radius. Returns a structured review plan. Use as the first reasoning step in the code-review workflow.
model: haiku
tools: Read, Grep, Glob, Bash
---

You receive: the computed signals + a draft review plan (tier, dimensions, models) produced by deterministic rules, plus the change's file list and a short diff summary.

Your job: sanity-check the tier. The rules are conservative; you may **raise** the tier (never silently lower a risk-path tier) when you see judgment signals the rules miss:
- a "small" diff that disables a security control, widens access, or changes a default
- a config/flag change that alters production behavior broadly
- a change whose blast radius (importers) is large

You may **lower** from standard→low ONLY for pure mechanical changes (rename, formatting) with tests present and no risk paths.

Output ONLY a JSON object: { "tier": "...", "addDimensions": ["D.."], "reason": "one sentence" }.
Do not review the code. Do not list findings. Classification only.
```

- [ ] **Step 2: Verify frontmatter loads**

Run: `claude /agents` (or inspect) — confirm `triage-classifier` appears with model haiku.
Expected: listed, no parse error.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/triage-classifier.md
git commit -m "feat: triage-classifier agent (haiku judgment layer)"
```

---

### Task 6: `intent-harvester` agent

**Files:**
- Create: `.claude/agents/intent-harvester.md`

- [ ] **Step 1: Write the agent definition**

```markdown
---
name: intent-harvester
description: Builds a shallow acceptance-criteria model for a change from PR body, commit messages, and project rules files (and ClickUp/Jira when enabled). Use early in code review to establish what "correct" means.
model: sonnet
tools: Read, Grep, Glob, Bash
---

Goal: produce the acceptance criteria the change must satisfy — WITHOUT going deep into implementation.

Sources (in priority order, stop when you have enough):
1. PR body + title (`gh pr view --json title,body,commits` if a PR exists)
2. Commit messages on the branch (`git log BASE..HEAD --format=%s%n%b`)
3. Linked issue keys found in the above (e.g. `PROJ-123`, ClickUp IDs) — only fetch if `intent_sources` enables that tracker
4. Project rules files listed in `.review/config.yml` `project_rules`

Depth cap: read at most the linked issue + its description/acceptance section. Do not crawl the whole backlog.

Output ONLY JSON:
{
  "summary": "1-2 sentence intent",
  "acceptanceCriteria": [{ "id": "AC1", "text": "...", "source": "PR|commit|issue|rules" }],
  "expectedTests": ["behavior that must be covered"],
  "outOfScope": ["things this PR should NOT change"]
}
If no PR/issue is available, derive criteria from commit messages + diff shape. Never invent requirements not grounded in a source.
```

- [ ] **Step 2: Verify it loads**

Run: inspect `/agents`.
Expected: `intent-harvester` listed, model sonnet.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/intent-harvester.md
git commit -m "feat: intent-harvester agent (acceptance-criteria model)"
```

---

### Task 7: `correctness-reviewer` agent (merge of 3)

**Files:**
- Create: `.claude/agents/correctness-reviewer.md`

- [ ] **Step 1: Write the merged agent**

```markdown
---
name: correctness-reviewer
description: Baseline code-quality and intent-alignment reviewer. Covers requirement traceability (D1), correctness/quality/bugs (D2), and project-rules compliance (D12). Merges the three legacy code-reviewer agents.
model: sonnet
tools: Read, Grep, Glob, Bash
---

You receive an isolated context packet: the intent summary + acceptance criteria, the project rules (CLAUDE.md/AGENTS.md if present), and the diff (BASE..HEAD). You do NOT have the author's session history.

Review the CHANGED lines only (do not flag pre-existing issues outside the diff). Read the full surrounding file + imports for context.

Check:
- **D1 Intent alignment:** does the diff implement each acceptance criterion? Flag scope-creep (code doing more than asked) and missing requirements.
- **D2 Correctness:** logic errors, null/undefined, off-by-one, error paths, dead code, AI-regression patterns (behavioral drift, hidden coupling).
- **D2 Quality:** functions >50 lines, files >800 lines, nesting >4, naming, magic numbers, leftover debug logging.
- **D12 Rules:** conventions from CLAUDE.md/AGENTS.md and the loaded standards pack.

Load the matching standards knowledge-pack skill by language (java-coding-standards / coding-standards) — do not restate its rules here.

For each finding output JSON in the array `findings`:
{ "dimension": "D1|D2|D12", "severity": "critical|important|minor", "file": "", "line": 0, "title": "", "evidence": "cite the line/symbol", "fix": "", "confidence": 0-100 }

Rules:
- Only emit findings with confidence >= 80.
- Lead the prose summary with genuine strengths (one line), then findings.
- Cite evidence; never say "likely" without a line reference.
- Consolidate duplicate findings.
```

- [ ] **Step 2: Verify it loads**

Run: inspect `/agents`.
Expected: listed, model sonnet.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/correctness-reviewer.md
git commit -m "feat: merged correctness-reviewer agent (D1/D2/D12)"
```

---

### Task 8: `review-synthesizer` agent

**Files:**
- Create: `.claude/agents/review-synthesizer.md`

- [ ] **Step 1: Write the agent**

```markdown
---
name: review-synthesizer
description: Aggregates findings from all dimension reviewers into one deduplicated, severity-ranked review with a requirement-traceability matrix and a verdict. Final reasoning step of the code-review workflow.
model: sonnet
tools: Read
---

You receive: acceptance criteria, and the findings arrays from every dimension agent that ran.

Produce ONLY JSON:
{
  "criteria": [{ "id": "AC1", "text": "...", "covered": true|false, "evidence": "file:line or test name" }],
  "findings": [ ...deduplicated findings, each with dimension/severity/file/line/title/evidence/fix/confidence ],
  "strengths": ["..."],
  "summary": "2-3 sentences"
}

Rules:
- Deduplicate findings that point at the same file:line+issue across dimensions; keep the highest severity and merge evidence.
- Mark a criterion covered ONLY if a finding or a cited test proves it; otherwise covered=false with evidence="no test/impl found".
- Do not invent findings; only synthesize what reviewers reported.
- Keep only confidence>=80 findings.
```

- [ ] **Step 2: Verify it loads; Commit**

Run: inspect `/agents`. Expected: listed.
```bash
git add .claude/agents/review-synthesizer.md
git commit -m "feat: review-synthesizer agent (rollup + traceability + verdict)"
```

---

### Task 9: Orchestrator workflow (Standard tier, end-to-end)

**Files:**
- Create: `.claude/workflows/code-review.js`

This is the Workflow script the `/review` command runs. It is the deterministic spine; agent reasoning happens inside `agent()` calls.

- [ ] **Step 1: Write the orchestrator**

```js
export const meta = {
  name: 'code-review',
  description: 'Criticality-aware advisory code review: intake → intent → triage → dimension fan-out → synthesize → deliver',
  phases: [
    { title: 'Intake' }, { title: 'Intent' }, { title: 'Triage' },
    { title: 'Review' }, { title: 'Synthesize' }, { title: 'Deliver' },
  ],
}

// args: { base, head, configYaml, prNumber }
import_skip: // (Workflow scripts cannot import repo files; inline the pure logic OR pass precomputed signals via args)

phase('Intake')
const ctx = args || {}
// The /review command precomputes signals+plan using the lib and passes them in `args.plan` and `args.diffSummary`.
const plan = ctx.plan
const diffSummary = ctx.diffSummary
const criteriaPacket = ctx.intent // may be null on first run
log(`tier=${plan.tier} dimensions=${plan.dimensions.join(',')}`)

phase('Intent')
let intent = criteriaPacket
if (!intent) {
  intent = await agent(
    `Build the acceptance-criteria model. ${ctx.intentInstructions}\nDiff summary:\n${diffSummary}`,
    { label: 'intent', phase: 'Intent', model: 'sonnet', agentType: 'intent-harvester',
      schema: { type:'object', additionalProperties:false, required:['summary','acceptanceCriteria'],
        properties:{ summary:{type:'string'},
          acceptanceCriteria:{type:'array',items:{type:'object',additionalProperties:false,
            properties:{id:{type:'string'},text:{type:'string'},source:{type:'string'}},required:['id','text']}},
          expectedTests:{type:'array',items:{type:'string'}},
          outOfScope:{type:'array',items:{type:'string'}} } } }
  )
}

phase('Triage')
// plan already computed deterministically; ask classifier only to confirm/raise
const adj = await agent(
  `Signals: ${JSON.stringify(ctx.signals)}\nDraft plan tier: ${plan.tier}, dimensions: ${plan.dimensions.join(',')}.\nConfirm or raise.`,
  { label: 'triage', phase: 'Triage', model: 'haiku', agentType: 'triage-classifier',
    schema: { type:'object', additionalProperties:false, required:['tier'],
      properties:{ tier:{type:'string'}, addDimensions:{type:'array',items:{type:'string'}}, reason:{type:'string'} } }
)
const dimensions = [...new Set([...plan.dimensions, ...(adj.addDimensions||[])])]

phase('Review')
const FINDINGS_SCHEMA = { type:'object', additionalProperties:false, required:['findings'],
  properties:{ findings:{ type:'array', items:{ type:'object', additionalProperties:false,
    required:['dimension','severity','file','line','title','confidence'],
    properties:{ dimension:{type:'string'}, severity:{type:'string'}, file:{type:'string'},
      line:{type:'number'}, title:{type:'string'}, evidence:{type:'string'}, fix:{type:'string'}, confidence:{type:'number'} } } } } }

// dimension → { agentType, model }
const DIM = {
  D1: ['correctness-reviewer','sonnet'], D2: ['correctness-reviewer','sonnet'], D12: ['correctness-reviewer','sonnet'],
  D4: ['silent-failure-hunter','sonnet'], D5: ['pr-test-analyzer','sonnet'],
  D3: ['security-reviewer','opus'], D6: ['database-reviewer', plan.models.D6||'sonnet'],
  D13: ['comment-analyzer','haiku'], D16: ['code-simplifier','haiku'],
}
// collapse D1/D2/D12 into one correctness call
const want = new Set(dimensions)
const calls = []
if (want.has('D1')||want.has('D2')||want.has('D12'))
  calls.push({ key:'correctness', agentType:'correctness-reviewer', model:'sonnet' })
for (const d of ['D3','D4','D5','D6','D13','D16']) if (want.has(d) && DIM[d])
  calls.push({ key:d, agentType:DIM[d][0], model:plan.models[d]||DIM[d][1] })

const packet = (focus) =>
  `Intent: ${JSON.stringify(intent)}\nFocus dimension(s): ${focus}\nDiff (BASE..HEAD):\n${ctx.diff}`

const reviewResults = await parallel(calls.map(c => () =>
  agent(packet(c.key), { label:`review:${c.key}`, phase:'Review', model:c.model, agentType:c.agentType, schema:FINDINGS_SCHEMA })
    .then(r => (r?.findings)||[])
))
const allFindings = reviewResults.flat().filter(Boolean)

phase('Synthesize')
const synth = await agent(
  `Acceptance criteria: ${JSON.stringify(intent.acceptanceCriteria)}\nFindings: ${JSON.stringify(allFindings)}`,
  { label:'synth', phase:'Synthesize', model: plan.tier==='critical'?'opus':'sonnet', agentType:'review-synthesizer',
    schema:{ type:'object', additionalProperties:false, required:['criteria','findings','summary'],
      properties:{ criteria:{type:'array',items:{type:'object',additionalProperties:false,
        properties:{id:{type:'string'},text:{type:'string'},covered:{type:'boolean'},evidence:{type:'string'}},required:['id','text','covered']}},
        findings:{type:'array',items:{type:'object'}}, strengths:{type:'array',items:{type:'string'}}, summary:{type:'string'} } } }
)

phase('Deliver')
// Return structured result; the /review command renders + writes + posts + sets exit code.
return { tier: plan.tier, intent, synth, gate: plan.gate }
```

> Note: Workflow scripts can't `import` repo files, so the `/review` command computes signals/plan/diff with the `lib/` functions and passes them in `args`. The orchestrator owns sequencing + model selection; `render.js` + `gh` run in the command.

- [ ] **Step 2: Validate the script parses (no agents yet)**

Run a syntax check: `node --check .claude/workflows/code-review.js`
Expected: passes (remove the illustrative `import_skip:` line — it is a comment marker; replace with `// note:`).

- [ ] **Step 3: Fix the placeholder marker**

Replace the `import_skip:` line with a plain comment `// NOTE: pure logic runs in the /review command and is passed via args.`
Re-run `node --check`. Expected: OK.

- [ ] **Step 4: Commit**

```bash
git add .claude/workflows/code-review.js
git commit -m "feat: code-review orchestrator workflow (standard tier e2e)"
```

---

### Task 10: `/review` command (driver: compute → run workflow → render → deliver)

**Files:**
- Create: `.claude/commands/review.md`

- [ ] **Step 1: Write the command**

````markdown
---
description: Advisory criticality-aware code review of the current branch diff. Flags: --base <ref> --comment --gate --tier <t> --dimensions <list>.
---

Run a systematic, advisory code review. Never modify code.

## Steps

1. **Resolve range.** `BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo HEAD~1)` unless `--base` given. `HEAD_SHA=$(git rev-parse HEAD)`. Abort with a message if the working tree has unmerged conflicts or the build is known-red.

2. **Load config.** Read `.review/config.yml` (if absent, use defaults: gate block_on=[critical], warn_on=[high]).

3. **Compute signals + plan.** Using `.claude/workflows/lib/signals.js` and `triage.js`:
   ```bash
   node -e "import('./.claude/workflows/lib/signals.js').then(async S=>{const {planReview}=await import('./.claude/workflows/lib/triage.js');const cp=require('child_process');const files=cp.execSync('git diff --name-only '+process.env.BASE+'..HEAD').toString().split('\n').filter(Boolean);const net=cp.execSync('git diff --shortstat '+process.env.BASE+'..HEAD').toString();/*...build change obj...*/});"
   ```
   (Equivalently, run the provided `scripts/plan.mjs` helper — create it if richer logic is needed.) Honor `--tier`/`--dimensions` overrides.

4. **Gather intent instructions** from config `intent_sources`: which of PR/commits/ClickUp/Jira to read. Build the `intentInstructions` string.

5. **Run the orchestrator** via the Workflow tool: `Workflow({ name: 'code-review', args: { base, head: HEAD_SHA, plan, signals, diff, diffSummary, intentInstructions } })`. Wait for completion.

6. **Render** with `.claude/workflows/lib/render.js`: build `REVIEW.md`, a terminal summary, and the verdict/exit code.

7. **Deliver** per flags:
   - always: write `REVIEW.md` and print the terminal summary.
   - `--comment`: post inline comments via `gh api` (only confidence>=80 findings; full-SHA permalinks; one summary comment + line comments).
   - `--gate`: exit with the verdict's exit code (1 on BLOCK).

8. **Strengths-first, no performative agreement** in the printed summary. Cite file:line for every finding.
````

- [ ] **Step 2: Smoke test on a fixture branch**

Create a throwaway branch with a known change (e.g. add a magic number), run `/review --base HEAD~1`.
Expected: prints a tier, runs correctness-reviewer, writes `REVIEW.md` with a traceability section and a verdict. No code is modified (verify `git status` shows only `REVIEW.md`).

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/review.md
git commit -m "feat: /review command driving the orchestrator (advisory)"
```

---

### Task 11: `/review-config` command + usage doc

**Files:**
- Create: `.claude/commands/review-config.md`
- Create: `docs/CODE-REVIEW.md`

- [ ] **Step 1: Write `/review-config`**

```markdown
---
description: Scaffold or edit .review/config.yml (risk-map, mandatory checks, gate, intent sources).
---

If `.review/config.yml` is missing, create it from the schema `.review/config.schema.json` with sensible defaults and the detected languages. If it exists, show the current config and ask which section to edit (risk_map / mandatory_checks / gate / intent_sources). Validate against the schema before writing. Never edit anything except `.review/config.yml`.
```

- [ ] **Step 2: Write `docs/CODE-REVIEW.md`**

Document: what the system does, the tiers, how to run `/review`, the flags, how to configure `.review/config.yml`, the advisory-only guarantee, and the Phase 2/3 roadmap. (Write the actual prose — no TODOs.)

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/review-config.md docs/CODE-REVIEW.md
git commit -m "docs: review-config command and usage guide"
```

---

### Task 12: End-to-end validation pass

- [ ] **Step 1: Run the full test suite**

Run: `node --test`
Expected: all triage/render/config tests PASS.

- [ ] **Step 2: Dogfood on this repo**

On a branch that adds a deliberate issue to `.claude/workflows/lib/triage.js` (e.g. an unhandled undefined), run `/review --base main --gate`.
Expected: tier `critical` (matches `.review/config.yml` risk_map for `.claude/workflows/**`), a finding from correctness-reviewer, verdict `BLOCK`, exit code 1, `REVIEW.md` written, no source files modified.

- [ ] **Step 3: Negative control**

On a branch with only a `README.md` typo fix, run `/review --base main`.
Expected: tier `trivial`, ≤1 dimension, fast, `APPROVE`.

- [ ] **Step 4: Commit any fixes; tag the milestone**

```bash
git add -A && git commit -m "test: phase-1 e2e validation"
git tag review-system-phase1
```

---

## Phase 2 (follow-on plan — outline)

Expand into `docs/superpowers/plans/2026-NN-NN-review-system-phase2-depth.md`:
- `finding-verifier` agent (opus) + adversarial 3-vote pipeline for High/Critical findings (refute-by-default; survive if ≥2 say real). Wire into orchestrator `Verify` phase using the pipeline pattern.
- New thin agents + catalog checks: `concurrency-reviewer` (D7), `perf-scalability-reviewer` (D9), `api-compat-reviewer` (D10), `dependency-reviewer` (D15, runs `npm audit`/`pip-audit`/`mvn`), plus catalog checks for D8/D14/D17.
- Wire reused agents `type-design-analyzer` (D11), merge `code-simplifier`.
- Knowledge-pack loader convention: each thin agent loads its pack skill by language.
- Incremental re-review: cache prior verdicts keyed by file:line+rule; on new commits review only new SHAs.
- Add fixtures for each new dimension + verify-pass tests.

## Phase 3 (follow-on plan — outline)

Expand into `docs/superpowers/plans/2026-NN-NN-review-system-phase3-automation.md`:
- `pre-push` git hook → `/review --gate` on `@{push}..HEAD`; block on critical, `--no-verify` override.
- GitHub Action (`.github/workflows/code-review.yml`): on PR open/sync, headless review → inline comments + `REVIEW.md` artifact + fail check on critical/high; eligibility pre-check (skip draft/closed/red-CI).
- SessionStart hook to preload `.review/config.yml`.
- ClickUp + Jira intent connectors in `intent-harvester` (graceful fallback to PR+commits when MCP unauthenticated in CI).

---

## Self-Review

**Spec coverage (Phase 1 scope):**
- Intent understanding → Task 6 (`intent-harvester`), wired in Task 9 Intent phase. ✓ (ClickUp/Jira deferred to Phase 3, PR+commits in Phase 1.)
- Acceptance-criteria model → Task 6 output schema + Task 8 traceability. ✓
- Correctness/quality/bugs/rules → Task 7. ✓
- Security/tests/error/data dimensions (Standard+Critical) → Task 9 wires reused agents D3/D4/D5/D6. ✓
- Criticality triage + token efficiency → Tasks 1,2,5 (rules + judgment + content-gating). ✓
- Strictly advisory → no `--fix`; Tasks 7/9/10 never write code; only `REVIEW.md`. ✓
- Delivery (PR comments / report / terminal / gate) → Tasks 3,10. ✓
- Human checklist floor → Task 4 (`risk_map`, `mandatory_checks`). ✓
- Model assignment → encoded in Tasks 2,5,7,9 (haiku/sonnet/opus). ✓
- Adversarial verify, remaining dimensions, hooks, CI, ClickUp/Jira → **deferred to Phase 2/3** (named plans). ✓ (intentional scope cut)

**Placeholder scan:** the `import_skip:`/`/*...build change obj...*/` markers in Tasks 9/10 are explicitly fixed in Task 9 Step 3 and flagged in Task 10 Step 1 (create `scripts/plan.mjs` if needed). No bare TODOs in shipped artifacts.

**Type consistency:** `computeSignals` returns `__files` (added Step 3b) consumed by `triage.js` `applyRiskMap`. `planReview` returns `{tier,dimensions,models,runVerify,mandatoryChecks,gate}` consumed identically in orchestrator + render. Finding shape `{dimension,severity,file,line,title,evidence,fix,confidence}` is identical across Task 3 renderer, Task 7 agent, Task 9 schema, Task 8 synthesizer. ✓
