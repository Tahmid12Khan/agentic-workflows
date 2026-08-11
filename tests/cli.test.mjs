// Integration tests for the bundled CLI scripts — the smoke checks, made permanent.
// Each spawns the script with the same node that runs the suite (process.execPath),
// so they work regardless of how node is installed. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceName } from '../lib/trim-diff.mjs';

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
  const dateDirs = readdirSync(join(cwd, '.adversarial-code-review')).filter((d) => d.startsWith('review-'));
  assert.ok(dateDirs.length === 1, 'must create the per-run date folder');
});

// WS9: `.adverserial-code-review` (typo) → `.adversarial-code-review` (correct). One release
// cycle of migration support: with no --base-dir, an install that still only has the OLD dir
// (no new one yet) keeps writing into it rather than silently forking state into a fresh dir.
test('report.mjs writes into the old .adverserial-code-review dir when only it exists (no --base-dir)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acr-migrate-'));
  mkdirSync(join(cwd, '.adverserial-code-review'), { recursive: true });
  const r = runReport(validPayload(), { cwd });
  assert.equal(r.status, 0);
  assert.ok(!existsSync(join(cwd, '.adversarial-code-review')), 'must not also create the new dir');
  const dateDirs = readdirSync(join(cwd, '.adverserial-code-review')).filter((d) => d.startsWith('review-'));
  assert.ok(dateDirs.length === 1, 'must write the per-run folder into the pre-existing old dir');
});

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
  // the resolved verify policy carries the escalation models through to the sandbox (camelCase)
  assert.equal(out.verify.modelFirst, 'sonnet');
  assert.equal(out.verify.modelEscalate, 'opus');
  assert.deepEqual(out.verify.escalateDirectSeverity, ['critical']);
  // review_instructions: this repo ships REVIEW.md, so the content (not just the path) is resolved
  // into the plan for the sandbox to inject as the highest-priority reviewBlock.
  assert.equal(out.reviewInstructionsPath, 'REVIEW.md');
  assert.ok(out.reviewInstructions.length > 0 && out.reviewInstructions.length <= 8000);
  // lever D (fan-out trim): plan.mjs forwards planReview's trimmed field (defaults to [] when off)
  assert.ok(Array.isArray(out.trimmed));
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

test('verify.mjs select honours verify.by_tier for the passed tier', () => {
  const cfg = { verify: { by_tier: { low: { reverify_below: 60, report_confidence: 60 } } } };
  const findings = [{ title: 'mid', confidence: 70, severity: 'minor' }];
  // low tier: 70 >= 60 → trusted, not selected
  const low = JSON.parse(run('verify.mjs', ['select'], { input: JSON.stringify({ findings, config: cfg, tier: 'low' }) }));
  assert.deepEqual(low.select.map((f) => f.title), []);
  // no tier → flat default 80 → 70 < 80 → selected
  const flat = JSON.parse(run('verify.mjs', ['select'], { input: JSON.stringify({ findings, config: cfg }) }));
  assert.deepEqual(flat.select.map((f) => f.title), ['mid']);
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

test('context-pack.mjs emits enclosing defs + in-repo callers from a real diff', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
    writeFileSync(join(repo, 'caller.mjs'), "import { add } from './math.mjs';\nconsole.log(add(1, 2));\n");
    git('add', '-A'); git('commit', '-qm', 'init');
    // change the body of add() (not its signature)
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  const s = a + b;\n  return s;\n}\n');
    writeFileSync(join(repo, 'diff.txt'), execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }));
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt')], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /CONTEXT PACK/);
    assert.match(out, /FILE: math\.mjs/);
    assert.match(out, /export function add\(a, b\)/); // the WHOLE enclosing def, not just the changed line
    assert.match(out, /const s = a \+ b;/);
    assert.match(out, /callers of changed exports/i);
    assert.match(out, /add <- caller\.mjs:/);          // in-repo caller found via git grep, def site excluded
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('context-pack.mjs --stats-out writes the same stats as JSON, without touching stdout', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-stats-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
    writeFileSync(join(repo, 'caller.mjs'), "import { add } from './math.mjs';\nconsole.log(add(1, 2));\n");
    git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  const s = a + b;\n  return s;\n}\n');
    writeFileSync(join(repo, 'diff.txt'), execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }));
    const statsPath = join(repo, 'context-stats.json');
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt'), '--stats-out', statsPath], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /CONTEXT PACK/);           // stdout still holds the pack text, not the stats
    assert.doesNotMatch(out, /sizeBytes/);
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'));
    assert.equal(stats.files, 1);
    assert.ok(stats.callerHits > 0);             // caller.mjs references add() (import line + call site)
    assert.ok(stats.sizeBytes > 0);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('context-pack.mjs --context-dir writes one fragment per file, named via sliceName, matching its pack section', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-fragdir-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
    writeFileSync(join(repo, 'caller.mjs'), "import { add } from './math.mjs';\nconsole.log(add(1, 2));\n");
    git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  const s = a + b;\n  return s;\n}\n');
    writeFileSync(join(repo, 'diff.txt'), execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }));
    const ctxDir = join(repo, 'context');
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt'), '--context-dir', ctxDir], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /CONTEXT PACK/);   // stdout still holds the whole pack, unaffected
    const files = readdirSync(ctxDir);
    assert.equal(files.length, 1);       // only math.mjs has new-side content (caller.mjs is unchanged)
    assert.equal(files[0], sliceName('math.mjs'));   // same derivation as that file's diff slice
    const fragment = readFileSync(join(ctxDir, files[0]), 'utf8');
    assert.match(fragment, /===== FILE: math\.mjs =====/);
    assert.match(fragment, /const s = a \+ b;/);
    assert.ok(out.includes(fragment), 'the fragment must be verbatim inside the whole pack');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('context-pack.mjs --context-dir failure degrades silently (pack still reaches stdout, no crash)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-fragdir-bad-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  return a + b;\n}\n');
    git('add', '-A'); git('commit', '-qm', 'init');
    writeFileSync(join(repo, 'math.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
    writeFileSync(join(repo, 'diff.txt'), execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }));
    writeFileSync(join(repo, 'blocked'), 'not a directory');   // occupies the path --context-dir needs as a dir
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt'), '--context-dir', join(repo, 'blocked')], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /CONTEXT PACK/);   // the whole pack still reaches stdout despite the fragment-write failure
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('context-pack.mjs --stats-out failure degrades silently (pack still reaches stdout)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-stats-bad-'));
  try {
    writeFileSync(join(repo, 'diff.txt'), '');
    // an unwritable path (nonexistent parent dir) — writeFileSync throws, caught and ignored
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt'), '--stats-out', join(repo, 'no-such-dir', 'stats.json')], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /no changed source files/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('context-pack.mjs degrades to a note when the diff has no changed source files', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-ctx-empty-'));
  try {
    writeFileSync(join(repo, 'diff.txt'), '');
    const out = execFileSync(node, [join(LIB, 'context-pack.mjs'), '--diff', join(repo, 'diff.txt')], { cwd: repo, encoding: 'utf8' });
    assert.match(out, /no changed source files/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('report.mjs writes review.md + review.html and blocks on a critical finding', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-report-'));
  try {
    const plan = { tier: 'critical', dimensions: ['D3'], dimensionLabels: { D3: 'Security' },
                   dimensionAgents: { D3: 'vuln-reviewer' }, models: { D3: 'sonnet' },
                   runVerify: false, sharded: false, shards: [], agents: ['vuln-reviewer'] };
    const input = JSON.stringify({
      tier: 'critical',
      findings: [{ dimension: 'D3', severity: 'critical', file: 'a.ts', line: 3, title: 'SQLi', confidence: 92, evidence: 'concat', fix: 'param' }],
      criteria: [{ id: 'AC1', text: 'x', covered: true }],
      needsHuman: [{ question: 'intended?', file: 'b.ts', line: 9, verify: { passes: 3, real: 1, refuted: 1 } }],
      gate: { block_on: ['critical'], warn_on: ['high'] },
      plan,
      agentRuns: { 'vuln-reviewer': 1 },
    });
    const out = run('report.mjs', ['--base-dir', join(tmp, '.adversarial-code-review')], { input, cwd: tmp });
    assert.match(out, /Verdict: BLOCK/);
    assert.match(out, /ACTION: 1 item/);
    const dateDirs = readdirSync(join(tmp, '.adversarial-code-review')).filter((d) => d.startsWith('review-'));
    assert.ok(dateDirs.length === 1);
    const dateDir = join(tmp, '.adversarial-code-review', dateDirs[0]);
    const runDirs = readdirSync(dateDir);
    assert.ok(runDirs.length === 1);
    const runDir = join(dateDir, runDirs[0]);
    assert.ok(existsSync(join(runDir, 'review.md')));
    assert.ok(existsSync(join(runDir, 'review.html')));
    assert.match(readFileSync(join(runDir, 'review.html'), 'utf8'), /Needs your input/);
    // WS6: machine-readable severity line on stdout + verdict.json in the run folder
    assert.match(out, /acr-severity: \{.*"critical":1.*"verdict":"BLOCK".*\}/);
    assert.ok(existsSync(join(runDir, 'verdict.json')));
    const vj = JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8'));
    assert.equal(vj.critical, 1);
    assert.equal(vj.verdict, 'BLOCK');
    assert.equal(vj.preExisting, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('WS6: gate.block_on:[critical,important] blocks on an important finding (CLI)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-blockon-'));
  try {
    const plan = { tier: 'standard', dimensions: ['D2'], dimensionLabels: { D2: 'Correctness' },
                   dimensionAgents: { D2: 'correctness-reviewer' }, models: { D2: 'sonnet' },
                   runVerify: false, sharded: false, shards: [], agents: ['correctness-reviewer'] };
    const input = JSON.stringify({
      tier: 'standard',
      findings: [{ dimension: 'D2', severity: 'important', file: 'a.ts', line: 3, title: 'bug', confidence: 92 }],
      criteria: [], gate: { block_on: ['critical', 'important'], warn_on: ['high'] },
      plan, agentRuns: { 'correctness-reviewer': 1 },
    });
    const out = run('report.mjs', ['--base-dir', join(tmp, '.adversarial-code-review')], { input, cwd: tmp });
    assert.match(out, /Verdict: BLOCK/);
    assert.match(out, /acr-severity: \{.*"important":1.*"verdict":"BLOCK".*\}/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('report.mjs writes into review-{date}/review-{counter}-pr-{n}/review.{md,html}', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-dir-'));
  try {
    const plan = { tier: 'high', dimensions: ['D2'], dimensionLabels: { D2: 'Correctness' },
                   dimensionAgents: { D2: 'correctness-reviewer' }, models: { D2: 'sonnet' },
                   runVerify: false, sharded: false, shards: [], agents: ['correctness-reviewer'] };
    const input = JSON.stringify({
      tier: 'high',
      findings: [{ dimension: 'D2', severity: 'minor', file: 'a.ts', line: 1, title: 'nit', confidence: 90 }],
      criteria: [{ id: 'AC1', text: 'works', covered: true }],
      prNumber: 7,
      startedAt: '2026-06-21T10:00:00Z',
      gate: { block_on: ['critical'], warn_on: ['high'] },
      plan,
      agentRuns: { 'correctness-reviewer': 1 },
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

test('usage.mjs tallies this run from the session main + subagent transcripts in the window', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-usage-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj'); // encodeProjectDir('/proj')
    const subDir = join(projDir, 'sess1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const line = (o) => JSON.stringify(o) + '\n';
    // main transcript: one in-window opus turn, one before the window (must be excluded)
    writeFileSync(join(projDir, 'sess1.jsonl'),
      line({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500, cache_creation_input_tokens: 50 } } }) +
      line({ timestamp: '2026-06-30T08:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 9999 } } }));
    // subagent transcript: one in-window sonnet reviewer turn
    writeFileSync(join(subDir, 'agent-abc.jsonl'),
      line({ timestamp: '2026-06-30T10:05:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 20 } } }));

    const out = JSON.parse(run('usage.mjs', ['--home', home, '--cwd', '/proj', '--session', 'sess1', '--since', '2026-06-30T09:00:00Z']));
    assert.equal(out.usage.inputTokens, 1200);   // 1000 (main) + 200 (subagent); 9999 excluded by window
    assert.equal(out.usage.outputTokens, 120);
    assert.equal(out.usage.messages, 2);
    assert.equal(out.usage.scope, 'session');
    assert.ok(out.usage.costUsd > 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('usage.mjs recurses into nested Workflow subagent transcripts + splits cost by scope/model', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-usage-nested-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    // Workflow reviewer transcripts nest deeper than subagents/: subagents/workflows/wf_*/
    const wfDir = join(projDir, 'sess1', 'subagents', 'workflows', 'wf_deadbeef');
    mkdirSync(wfDir, { recursive: true });
    const line = (o) => JSON.stringify(o) + '\n';
    writeFileSync(join(projDir, 'sess1.jsonl'),
      line({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 500 } } }));
    // a reviewer transcript two levels below subagents/ — the old one-level scan missed this
    writeFileSync(join(wfDir, 'agent-r1.jsonl'),
      line({ timestamp: '2026-06-30T10:05:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 4000, output_tokens: 400, cache_read_input_tokens: 1000 } } }));

    const out = JSON.parse(run('usage.mjs', ['--home', home, '--cwd', '/proj', '--session', 'sess1', '--since', '2026-06-30T09:00:00Z']));
    assert.equal(out.usage.inputTokens, 5000, 'nested reviewer cost must be counted, not silently dropped');
    assert.equal(out.usage.messages, 2);
    // aggregate cache hit% = 1500 / (1500 + 5000)
    assert.equal(out.usage.cacheHitPct, 1500 / 6500);
    // breakdown: orchestrator/opus and subagents/sonnet, most-expensive first
    const scopes = out.usage.breakdown.map((b) => `${b.scope}/${b.model}`);
    assert.ok(scopes.includes('orchestrator/opus'));
    assert.ok(scopes.includes('subagents/sonnet'));
    assert.ok(out.usage.breakdown[0].costUsd >= out.usage.breakdown[1].costUsd, 'breakdown sorted by cost desc');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('history.mjs emits the fix/bug prior per changed file from a real repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-hist-'));
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'pay.mjs'), 'export const rate = 1;\n');
    git('add', '-A'); git('commit', '-qm', 'feat: add pay');
    writeFileSync(join(repo, 'pay.mjs'), 'export const rate = 2;\n');
    git('add', '-A'); git('commit', '-qm', 'fix: correct rounding on refund');
    // now stage a further change and diff it
    writeFileSync(join(repo, 'pay.mjs'), 'export const rate = 3;\n');
    writeFileSync(join(repo, 'diff.txt'), execFileSync('git', ['diff'], { cwd: repo, encoding: 'utf8' }));
    const out = JSON.parse(execFileSync(node, [join(LIB, 'history.mjs'), '--diff', join(repo, 'diff.txt')], { cwd: repo, encoding: 'utf8' }));
    assert.ok(out.history['pay.mjs'], 'the changed file must carry its history');
    assert.ok(out.history['pay.mjs'].some((s) => /rounding on refund/.test(s)), 'fix subject present');
    assert.ok(!out.history['pay.mjs'].some((s) => /add pay/.test(s)), 'non-fix subject excluded');
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('history.mjs degrades to an empty prior on an empty diff', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-hist-empty-'));
  try {
    writeFileSync(join(repo, 'diff.txt'), '');
    const out = JSON.parse(execFileSync(node, [join(LIB, 'history.mjs'), '--diff', join(repo, 'diff.txt')], { cwd: repo, encoding: 'utf8' }));
    assert.deepEqual(out.history, {});
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('test-signal.mjs runs the configured command and reports pass / fail+names / not-configured', () => {
  const mk = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'acr-ts-'));
    mkdirSync(join(cwd, '.adversarial-code-review'), { recursive: true });
    return cwd;
  };
  const write = (cwd, cfg) => writeFileSync(join(cwd, '.adversarial-code-review', 'config.json'), JSON.stringify(cfg));
  const runTS = (cwd) => JSON.parse(execFileSync(node, [join(LIB, 'test-signal.mjs')], { cwd, encoding: 'utf8' }));

  // passing command
  let cwd = mk();
  write(cwd, { tests: { command: `${JSON.stringify(node)} -e "process.exit(0)"` } });
  let out = runTS(cwd);
  assert.equal(out.ran, true); assert.equal(out.passed, true); assert.deepEqual(out.failing, []);
  rmSync(cwd, { recursive: true, force: true });

  // failing command that prints a TAP failure and exits non-zero
  cwd = mk();
  write(cwd, { tests: { command: `${JSON.stringify(node)} -e "console.log('not ok 1 - boom'); process.exit(1)"` } });
  out = runTS(cwd);
  assert.equal(out.ran, true); assert.equal(out.passed, false);
  assert.deepEqual(out.failing, ['boom']);
  rmSync(cwd, { recursive: true, force: true });

  // no command configured → never guessed, ran:false
  cwd = mk();
  write(cwd, {});
  out = runTS(cwd);
  assert.equal(out.ran, false); assert.equal(out.passed, null);
  assert.ok(out.notes.some((n) => /not configured/.test(n)));
  rmSync(cwd, { recursive: true, force: true });
});

// WS9: `.adverserial-code-review` (typo) → `.adversarial-code-review` (correct). One release
// cycle of migration support: an install that still only has the OLD dir keeps working.
test('test-signal.mjs falls back to the old .adverserial-code-review dir when the new one is absent', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acr-ts-migrate-'));
  try {
    mkdirSync(join(cwd, '.adverserial-code-review'), { recursive: true });
    writeFileSync(join(cwd, '.adverserial-code-review', 'config.json'), JSON.stringify({ tests: { command: `${JSON.stringify(node)} -e "process.exit(0)"` } }));
    const out = JSON.parse(execFileSync(node, [join(LIB, 'test-signal.mjs')], { cwd, encoding: 'utf8' }));
    assert.equal(out.ran, true);
    assert.equal(out.passed, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('plan.mjs --incremental narrows to prevHead..head on a fast-forward, falls open to base..head on a rebase (S9)', () => {
  const repo = mkdtempSync(join(tmpdir(), 'acr-inc-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
  const acrDir = join(repo, '.adversarial-code-review');
  const writeLast = (o) => { mkdirSync(acrDir, { recursive: true }); writeFileSync(join(acrDir, 'last-review.json'), JSON.stringify(o)); };
  try {
    g('init', '-q');
    g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const base = g('rev-parse', 'HEAD').trim();
    // C1 — the head that was "already reviewed"
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 2;\n');
    g('add', '-A'); g('commit', '-qm', 'C1');
    const c1 = g('rev-parse', 'HEAD').trim();
    // C2 — a new commit on top → fast-forward advance from C1, touches a NEW file
    writeFileSync(join(repo, 'b.mjs'), 'export const b = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'C2');
    const head = g('rev-parse', 'HEAD').trim();

    // prior review recorded at C1 → --incremental narrows to C1..head (only the new commit's diff)
    writeLast({ version: 1, base, head: c1, range: `${base}..${c1}`, findings: [] });
    const ff = JSON.parse(run('plan.mjs', ['--incremental', '--base', base], { cwd: repo }));
    assert.equal(ff.incremental.applied, true, 'fast-forward advance is incremental');
    assert.equal(ff.range, `${c1}..${head}`, 'range narrowed to prevHead..head');
    assert.deepEqual(ff.files, ['b.mjs'], 'only the new commit\'s file is in scope');

    // --full opts back out even with prior state → the complete base..head review
    const full = JSON.parse(run('plan.mjs', ['--incremental', '--full', '--base', base], { cwd: repo }));
    assert.equal(full.incremental.applied, false);
    assert.equal(full.range, `${base}..${head}`);

    // rebase / force-push: rewrite history so the recorded C1 is NOT an ancestor of the new head
    g('reset', '--hard', base);
    writeFileSync(join(repo, 'a.mjs'), 'export const a = 99;\n');
    g('add', '-A'); g('commit', '-qm', 'C1-rewritten');
    writeFileSync(join(repo, 'b.mjs'), 'export const b = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'C2-rewritten');
    const newHead = g('rev-parse', 'HEAD').trim();
    writeLast({ version: 1, base, head: c1, range: `${base}..${c1}`, findings: [] });  // still points at the orphaned C1
    const reb = JSON.parse(run('plan.mjs', ['--incremental', '--base', base], { cwd: repo }));
    assert.equal(reb.incremental.applied, false, 'non-fast-forward must fall open to a full review, never silently skip');
    assert.equal(reb.range, `${base}..${newHead}`, 'full base..head range on a rebase');
    assert.match(reb.incremental.reason, /non-fast-forward/i);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test('report.mjs script-writes last-review.json and marks new findings under --incremental (S9)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-inc-report-'));
  const baseDir = join(tmp, '.adversarial-code-review');
  try {
    mkdirSync(baseDir, { recursive: true });
    // a prior review recorded one finding at an earlier head
    writeFileSync(join(baseDir, 'last-review.json'), JSON.stringify({ version: 1, base: 'B0', head: 'H0', range: 'B0..H0', findings: [{ file: 'a.ts', title: 'old bug' }] }));
    const plan = { tier: 'standard', base: 'B1', head: 'H1', range: 'B1..H1', dimensions: ['D2'], dimensionLabels: { D2: 'Correctness' },
                   dimensionAgents: { D2: 'correctness-reviewer' }, models: { D2: 'sonnet' }, runVerify: false, sharded: false, shards: [], agents: ['correctness-reviewer'] };
    const payload = {
      tier: 'standard', range: 'B1..H1', incremental: true,
      findings: [
        { dimension: 'D2', severity: 'minor', file: 'a.ts', line: 1, title: 'old bug', confidence: 90 },
        { dimension: 'D2', severity: 'minor', file: 'b.ts', line: 2, title: 'fresh bug', confidence: 90 },
      ],
      gate: { block_on: ['critical'], warn_on: ['high'] },
      plan, agentRuns: { 'correctness-reviewer': 1 },
    };
    const r = runReport(payload, { cwd: tmp, args: ['--base-dir', baseDir] });
    assert.equal(r.status, 0);
    // last-review.json re-keyed to this run's head + carries both findings (minimal projection)
    const last = JSON.parse(readFileSync(join(baseDir, 'last-review.json'), 'utf8'));
    assert.equal(last.head, 'H1');
    assert.deepEqual(last.findings.map((f) => f.title).sort(), ['fresh bug', 'old bug']);
    // the report marks the finding not seen last run as "new"
    const dateDir = join(baseDir, readdirSync(baseDir).find((d) => d.startsWith('review-')));
    const runDir = join(dateDir, readdirSync(dateDir)[0]);
    assert.match(readFileSync(join(runDir, 'review.md'), 'utf8'), /fresh bug\*\* \(D2 · new ·/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('usage.mjs returns null when there is no transcript dir (degrade, no panel)', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-usage-empty-'));
  try {
    const out = JSON.parse(run('usage.mjs', ['--home', home, '--cwd', '/nope', '--session', 'x', '--since', '2026-06-30T00:00:00Z']));
    assert.equal(out.usage, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
