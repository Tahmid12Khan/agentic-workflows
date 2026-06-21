// Integration tests for the bundled CLI scripts — the smoke checks, made permanent.
// Each spawns the script with the same node that runs the suite (process.execPath),
// so they work regardless of how node is installed. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;

function run(script, args = [], { input, cwd = REPO } = {}) {
  return execFileSync(node, [join(LIB, script), ...args], { input, cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

test('plan.mjs emits a JSON plan with the expected keys', () => {
  const out = JSON.parse(run('plan.mjs'));
  for (const k of ['tier', 'dimensions', 'agents', 'models', 'verify', 'escalation', 'shards', 'gate', 'diffSummary']) {
    assert.ok(k in out, `plan missing key ${k}`);
  }
  assert.ok(out.verify.maxPassesPerAspect <= 3);
});

test('verify.mjs select picks only the low-confidence finding', () => {
  const input = JSON.stringify({
    findings: [{ title: 'a', confidence: 95, severity: 'minor' }, { title: 'b', confidence: 60, severity: 'important' }],
    config: { verify: { reverify_below: 80 } },
  });
  const out = JSON.parse(run('verify.mjs', ['select'], { input }));
  assert.deepEqual(out.select.map((f) => f.title), ['b']);
  assert.equal(out.maxVerifierPasses, 2);
});

test('verify.mjs resolve keeps confirmed, drops refuted, escalates ties', () => {
  const input = JSON.stringify({
    findings: [
      { title: 'keep', confidence: 60, severity: 'important', verdicts: [{ verdict: 'real' }, { verdict: 'real' }] },
      { title: 'drop', confidence: 50, severity: 'minor', verdicts: [{ verdict: 'refuted' }, { verdict: 'refuted' }] },
      { title: 'ask', confidence: 55, severity: 'important', verdicts: [{ verdict: 'real' }, { verdict: 'refuted' }] },
    ],
    config: {},
  });
  const out = JSON.parse(run('verify.mjs', ['resolve'], { input }));
  assert.deepEqual(out.report.map((f) => f.title), ['keep']);
  assert.deepEqual(out.dropped.map((f) => f.title), ['drop']);
  assert.deepEqual(out.needsHuman.map((f) => f.title), ['ask']);
});

test('scan.mjs returns a JSON envelope even with no scanner', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-scan-'));
  try {
    const out = JSON.parse(run('scan.mjs', [], { cwd: tmp }));
    assert.ok(Array.isArray(out.findings));
    assert.ok(Array.isArray(out.notes));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('report.mjs writes REVIEW.md + REVIEW.html and blocks on a critical finding', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-report-'));
  try {
    const input = JSON.stringify({
      tier: 'critical',
      findings: [{ dimension: 'D3', severity: 'critical', file: 'a.ts', line: 3, title: 'SQLi', confidence: 92, evidence: 'concat', fix: 'param' }],
      criteria: [{ id: 'AC1', text: 'x', covered: true }],
      needsHuman: [{ question: 'intended?', file: 'b.ts', line: 9, verify: { passes: 3, real: 1, refuted: 1 } }],
      gate: { block_on: ['critical'], warn_on: ['high'] },
    });
    const out = run('report.mjs', ['--out', join(tmp, 'REVIEW.md'), '--html', join(tmp, 'REVIEW.html')], { input, cwd: tmp });
    assert.match(out, /Verdict: BLOCK/);
    assert.match(out, /ACTION: 1 item/);
    assert.ok(existsSync(join(tmp, 'REVIEW.md')));
    assert.ok(existsSync(join(tmp, 'REVIEW.html')));
    assert.match(readFileSync(join(tmp, 'REVIEW.html'), 'utf8'), /Needs your input/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('report.mjs writes into review-{date}/review-{counter}-pr-{n}/review.{md,html}', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-dir-'));
  try {
    const input = JSON.stringify({
      tier: 'high',
      findings: [{ dimension: 'D2', severity: 'minor', file: 'a.ts', line: 1, title: 'nit', confidence: 90 }],
      criteria: [{ id: 'AC1', text: 'works', covered: true }],
      prNumber: 7,
      startedAt: '2026-06-21T10:00:00Z',
      gate: { block_on: ['critical'], warn_on: ['high'] },
    });
    const out = run('report.mjs', ['--base-dir', tmp], { input, cwd: tmp });
    const dateDirs = readdirSync(tmp).filter((d) => /^review-\d{4}-\d{2}-\d{2}$/.test(d));
    assert.deepEqual(dateDirs, ['review-2026-06-21']);     // outer folder is the review date
    const dateDir = join(tmp, dateDirs[0]);
    assert.deepEqual(readdirSync(dateDir), ['review-1-pr-7']); // inner folder is counter + pr
    assert.ok(existsSync(join(dateDir, 'review-1-pr-7', 'review.md')));
    assert.ok(existsSync(join(dateDir, 'review-1-pr-7', 'review.html')));
    assert.match(readFileSync(join(dateDir, 'review-1-pr-7', 'review.md'), 'utf8'), /PR #7/);
    assert.match(out, /PR #7/);
    // a second run the same day increments the per-day counter
    run('report.mjs', ['--base-dir', tmp], { input, cwd: tmp });
    assert.ok(readdirSync(dateDir).includes('review-2-pr-7'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('memory.mjs records a run and loads it back', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-mem-'));
  const store = join(tmp, 'learnings.json');
  try {
    run('memory.mjs', ['record', store], { input: JSON.stringify({ reported: [{ file: 'a.ts', title: 'x' }], needsHuman: [{ title: 'unsure?', file: 'b.ts' }], range: 'r1' }) });
    const loaded = JSON.parse(run('memory.mjs', ['load', store]));
    assert.equal(loaded.recurring.length, 1);
    assert.equal(loaded.unresolved.length, 1);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('route.mjs scrutiny + checks route deterministically', () => {
  const scr = JSON.parse(run('route.mjs', ['scrutiny'], { input: JSON.stringify({ groups: [{ label: 'x', kind: 'extra', withinScope: false, files: ['b.ts'] }] }) }));
  assert.equal(scr.targets.length, 1);
  const chk = JSON.parse(run('route.mjs', ['checks'], { input: JSON.stringify({ mandatoryChecks: ['no secrets committed'] }) }));
  assert.equal(chk.checks[0].dimension, 'D3');
});

test('route.mjs spawn enforces the per-aspect cap across threaded calls', () => {
  let ledger = {};
  const key = 'verify:src/auth.ts:42';
  for (let i = 1; i <= 3; i++) {
    const out = JSON.parse(run('route.mjs', ['spawn'], { input: JSON.stringify({ ledger, key, max: 3 }) }));
    assert.equal(out.ok, true);
    assert.equal(out.count, i);
    ledger = out.ledger;
  }
  const capped = JSON.parse(run('route.mjs', ['spawn'], { input: JSON.stringify({ ledger, key, max: 3 }) }));
  assert.equal(capped.ok, false);   // 4th dispatch on the aspect refused by code
  assert.equal(capped.capped, true);
});

test('verify.mjs select attaches a per-dimension adversarial lens', () => {
  const input = JSON.stringify({
    findings: [{ title: 'sqli', dimension: 'D3', confidence: 60, severity: 'important' }],
    config: {},
  });
  const out = JSON.parse(run('verify.mjs', ['select'], { input }));
  assert.equal(out.select[0].lens, 'security');
  assert.ok(out.select[0].focus.length > 0);
});

test('comments.mjs --dry-run builds comment bodies offline', () => {
  const input = JSON.stringify({ findings: [{ file: 'a.ts', line: 5, severity: 'important', dimension: 'D2', title: 'off-by-one', evidence: 'i<=len', fix: 'use <', confidence: 88 }] });
  const out = JSON.parse(run('comments.mjs', ['--dry-run'], { input }));
  assert.equal(out.length, 1);
  assert.match(out[0].body, /Suggested fix/);
});

test('preflight.mjs reports readiness', () => {
  // exits 0 when node+git present (this repo); just assert it runs and mentions node
  const out = run('preflight.mjs');
  assert.match(out, /preflight/i);
});
