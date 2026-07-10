// Blast-radius escalation (fan-in): a one-line change to a widely-imported module can slip to
// low/standard tier on lexical signals alone (signals.mjs never looks at WHO imports the file).
// Covers the pure specifier helper (signals.mjs), the escalation rule (triage.mjs, via planReview's
// 5th arg), and an end-to-end CLI check (plan.mjs) over a real git repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { moduleSpecifiers } from '../lib/signals.mjs';
import { planReview } from '../lib/triage.mjs';

// --- moduleSpecifiers: importable specifiers for a changed file (pure) ---

test('moduleSpecifiers: nested file yields basename + full path, both without extension', () => {
  assert.deepEqual(moduleSpecifiers('lib/config.mjs'), ['config', 'lib/config']);
});

test('moduleSpecifiers: root-level file dedupes to a single specifier', () => {
  assert.deepEqual(moduleSpecifiers('index.mjs'), ['index']);
});

test('moduleSpecifiers: deeper nesting keeps the full repo-relative path variant', () => {
  assert.deepEqual(moduleSpecifiers('src/utils/helpers.ts'), ['helpers', 'src/utils/helpers']);
});

test('moduleSpecifiers: extensionless file falls back to itself for both variants', () => {
  assert.deepEqual(moduleSpecifiers('Dockerfile'), ['Dockerfile']);
});

// --- fan-in escalation rule (lib/triage.mjs, wired via planReview's 5th arg) ---

const LOW_SIGNALS = { riskPaths: [], languages: [], fileCount: 2, netLoc: 10, testsPresent: true };
const STANDARD_SIGNALS = { riskPaths: [], languages: [], fileCount: 5, netLoc: 100, testsPresent: false };

test('fan-in below threshold: no bump, no note', () => {
  const plan = planReview(STANDARD_SIGNALS, {}, undefined, undefined, { count: 19, file: 'lib/config.mjs' });
  assert.equal(plan.tier, 'standard');
  assert.deepEqual(plan.notes, []);
});

test('fan-in at threshold: standard bumps to high, with a note naming the file + count', () => {
  const plan = planReview(STANDARD_SIGNALS, {}, undefined, undefined, { count: 20, file: 'lib/config.mjs' });
  assert.equal(plan.tier, 'high');
  assert.deepEqual(plan.notes, ['fan-in escalation: lib/config.mjs imported by 20 files']);
});

test('fan-in at threshold: low bumps to standard', () => {
  const plan = planReview(LOW_SIGNALS, {}, undefined, undefined, { count: 20, file: 'lib/util.mjs' });
  assert.equal(plan.tier, 'standard');
  assert.deepEqual(plan.notes, ['fan-in escalation: lib/util.mjs imported by 20 files']);
});

test('fan-in never bumps high to critical', () => {
  const cfg = { risk_map: { high: ['src/x.mjs'] } };
  const signals = { ...STANDARD_SIGNALS, __files: ['src/x.mjs'] };
  const plan = planReview(signals, cfg, undefined, undefined, { count: 999, file: 'src/x.mjs' });
  assert.equal(plan.tier, 'high');
  assert.deepEqual(plan.notes, []); // risk_map already put it at high — fan-in must not push further
});

test('config.fanin_threshold: 0 disables the escalation entirely', () => {
  const plan = planReview(STANDARD_SIGNALS, { fanin_threshold: 0 }, undefined, undefined, { count: 999, file: 'lib/config.mjs' });
  assert.equal(plan.tier, 'standard');
  assert.deepEqual(plan.notes, []);
});

test('config.fanin_threshold: a lower custom threshold is honored', () => {
  const plan = planReview(STANDARD_SIGNALS, { fanin_threshold: 3 }, undefined, undefined, { count: 3, file: 'lib/util.mjs' });
  assert.equal(plan.tier, 'high');
});

test('no fanIn arg (today\'s call sites): identical to before this change', () => {
  const plan = planReview(STANDARD_SIGNALS, {});
  assert.equal(plan.tier, 'standard');
  assert.deepEqual(plan.notes, []);
});

// --- CLI: plan.mjs end to end over a real git repo ---

test('plan.mjs: a change to a file imported by >= fanin_threshold other files escalates the tier', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-fanin-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  try {
    g('init', '-q');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    mkdirSync(join(repo, '.adversarial-code-review'), { recursive: true });
    writeFileSync(join(repo, '.adversarial-code-review', 'config.json'), JSON.stringify({ fanin_threshold: 2 }));
    writeFileSync(join(repo, 'util.mjs'), 'export function helper(x) {\n  return x + 1;\n}\n');
    writeFileSync(join(repo, 'caller1.mjs'), "import { helper } from './util.mjs';\nhelper(1);\n");
    writeFileSync(join(repo, 'caller2.mjs'), "import { helper } from './util.mjs';\nhelper(2);\n");
    writeFileSync(join(repo, 'caller3.mjs'), "import { helper } from './util.mjs';\nhelper(3);\n");
    g('add', '-A'); g('commit', '-qm', 'init');
    // change only the function BODY (not the export line), so publicContract stays false and the
    // pre-fan-in tier is 'standard', not already 'critical' via the existing hot-path signal.
    writeFileSync(join(repo, 'util.mjs'), 'export function helper(x) {\n  return x + 2;\n}\n');
    g('add', '-A'); g('commit', '-qm', 'tweak util body');

    const node = process.execPath;
    const PLAN = fileURLToPath(new URL('../lib/plan.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(node, [PLAN], { cwd: repo, encoding: 'utf8' }));
    assert.equal(out.tier, 'high', 'standard bumped to high by fan-in');
    assert.ok(
      out.notes.some((n) => /fan-in escalation: util\.mjs imported by 3 files/.test(n)),
      `expected a fan-in note, got: ${JSON.stringify(out.notes)}`
    );
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('plan.mjs: fan-in check is skipped (no note, no bump) when fanin_threshold is 0', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-fanin-off-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  try {
    g('init', '-q');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    mkdirSync(join(repo, '.adversarial-code-review'), { recursive: true });
    writeFileSync(join(repo, '.adversarial-code-review', 'config.json'), JSON.stringify({ fanin_threshold: 0 }));
    writeFileSync(join(repo, 'util.mjs'), 'export function helper(x) {\n  return x + 1;\n}\n');
    writeFileSync(join(repo, 'caller1.mjs'), "import { helper } from './util.mjs';\nhelper(1);\n");
    writeFileSync(join(repo, 'caller2.mjs'), "import { helper } from './util.mjs';\nhelper(2);\n");
    writeFileSync(join(repo, 'caller3.mjs'), "import { helper } from './util.mjs';\nhelper(3);\n");
    g('add', '-A'); g('commit', '-qm', 'init');
    writeFileSync(join(repo, 'util.mjs'), 'export function helper(x) {\n  return x + 2;\n}\n');
    g('add', '-A'); g('commit', '-qm', 'tweak util body');

    const node = process.execPath;
    const PLAN = fileURLToPath(new URL('../lib/plan.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(node, [PLAN], { cwd: repo, encoding: 'utf8' }));
    assert.equal(out.tier, 'standard', 'no escalation with the lever off');
    assert.deepEqual(out.notes, []);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});
