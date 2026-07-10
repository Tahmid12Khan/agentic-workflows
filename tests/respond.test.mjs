// Unit + CLI-smoke tests for respond.mjs — the /review-respond author-side loop (WS5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLatestReportFolder, parseFindingsFromReport, FORBIDDEN_PHRASES, containsPerformativePhrase,
  validateResponses, evaluateScopeGuard, applyOneFix, applyFixes, buildFpCandidate,
} from '../lib/respond.mjs';

const RESPOND = new URL('../lib/respond.mjs', import.meta.url).pathname;

// --- findLatestReportFolder ---

test('findLatestReportFolder picks the newest date, then the highest counter within it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-'));
  try {
    for (const [d, runs] of Object.entries({
      'review-2026-07-08': ['review-1'],
      'review-2026-07-09': ['review-1', 'review-2', 'review-10'], // numeric, not lexicographic
    })) {
      for (const r of runs) {
        const p = join(dir, d, r);
        mkdirSync(p, { recursive: true });
        writeFileSync(join(p, 'review.md'), '# Code Review\n');
      }
    }
    const got = findLatestReportFolder(dir);
    assert.equal(got, join(dir, 'review-2026-07-09', 'review-10'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('findLatestReportFolder skips run dirs without a review.md and degrades to null when empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-'));
  try {
    mkdirSync(join(dir, 'review-2026-07-09', 'review-1'), { recursive: true }); // no review.md
    assert.equal(findLatestReportFolder(dir), null);
    assert.equal(findLatestReportFolder(join(dir, 'does-not-exist')), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- parseFindingsFromReport ---

test('parseFindingsFromReport extracts findings matching render.mjs\'s exact bullet format', () => {
  const md = [
    '# Code Review — standard', '',
    '## Critical', '',
    '- **SQL injection risk** (D3 · new · verified ×2) — `src/db.js:42` _(conf 92)_',
    '  - evidence: string-concatenated query at line 42',
    '  - fix: use a parameterized query',
    '',
    '## Minor', '',
    '- **Missing null check** (D2 · trusted) — `src/util.js:10` _(conf 81)_',
    '  - evidence: arg can be undefined per caller at src/a.js:5',
    '',
    '## Requirement traceability', '',
    '- [x] **something** — covered',
  ].join('\n');

  const findings = parseFindingsFromReport(md);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings[0], {
    id: 'f0', severity: 'critical', dimension: 'D3', title: 'SQL injection risk',
    file: 'src/db.js', line: 42, confidence: 92, isNew: true, recurring: false,
    verify: { passes: 2 }, evidence: 'string-concatenated query at line 42',
    fix: 'use a parameterized query',
  });
  assert.deepEqual(findings[1], {
    id: 'f1', severity: 'minor', dimension: 'D2', title: 'Missing null check',
    file: 'src/util.js', line: 10, confidence: 81, isNew: false, recurring: false,
    verify: null, evidence: 'arg can be undefined per caller at src/a.js:5', fix: '',
  });
});

test('parseFindingsFromReport returns nothing for a report with no severity sections', () => {
  assert.deepEqual(parseFindingsFromReport('# Code Review\n\nNo findings.\n'), []);
  assert.deepEqual(parseFindingsFromReport(''), []);
});

// --- forbidden performative phrases ---

test('containsPerformativePhrase catches the ported forbidden list, case-insensitively', () => {
  assert.ok(containsPerformativePhrase("You're absolutely right!"));
  assert.ok(containsPerformativePhrase('Great catch, fixing now'));
  assert.ok(containsPerformativePhrase('Thanks for catching that'));
  assert.equal(containsPerformativePhrase('Verified against src/db.js:42 — the guard does not cover this path'), false);
  assert.ok(FORBIDDEN_PHRASES.length > 0);
});

test('containsPerformativePhrase catches the bare "you\'re right" form, not just "absolutely right"', () => {
  assert.ok(containsPerformativePhrase("You're right!"));
  assert.ok(containsPerformativePhrase('youre right, fixing now'));
  // "you're absolutely right" still matches only once in FORBIDDEN_PHRASES — no double-count concern,
  // .some() short-circuits on the first hit regardless of how many entries match.
  assert.ok(containsPerformativePhrase("You're absolutely right!"));
});

// --- validateResponses (stance JSON schema) ---

test('validateResponses accepts a well-formed batch', () => {
  const { valid, errors } = validateResponses([
    { id: 'f0', stance: 'agree', evidence: 'confirmed at src/db.js:42, no parameterization', applied: false },
    { id: 'f1', stance: 'disagree', evidence: 'guard at src/util.js:8 already covers this — refuted', applied: false },
    { id: 'f2', stance: 'needs-human', evidence: 'ambiguous whether this input can ever be empty' },
  ]);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateResponses rejects a malformed stance, missing id, and blank evidence', () => {
  const { valid, errors } = validateResponses([
    { id: 'f0', stance: 'yes', evidence: 'x' },
    { stance: 'agree', evidence: 'x' },
    { id: 'f2', stance: 'agree', evidence: '   ' },
  ]);
  assert.equal(valid, false);
  assert.equal(errors.length, 3);
});

test('validateResponses warns (not errors) on an uncited disagree and on performative language', () => {
  const { valid, warnings } = validateResponses([
    { id: 'f0', stance: 'disagree', evidence: 'this seems fine to me' },
    { id: 'f1', stance: 'agree', evidence: "You're absolutely right, fixing at src/a.js:1" },
  ]);
  assert.equal(valid, true);
  assert.equal(warnings.length, 2);
});

// --- evaluateScopeGuard ---

test('evaluateScopeGuard only refuses dirty/detached when --fix is on', () => {
  assert.deepEqual(evaluateScopeGuard({ dirty: true, detachedHead: false, fix: false }), { blocked: false, reason: null });
  assert.deepEqual(evaluateScopeGuard({ dirty: false, detachedHead: true, fix: false }), { blocked: false, reason: null });
  assert.equal(evaluateScopeGuard({ dirty: true, detachedHead: false, fix: true }).blocked, true);
  assert.equal(evaluateScopeGuard({ dirty: false, detachedHead: true, fix: true }).blocked, true);
  assert.deepEqual(evaluateScopeGuard({ dirty: false, detachedHead: false, fix: true }), { blocked: false, reason: null });
});

// --- applyOneFix / applyFixes: pure planner over an in-memory mock file store ---

function makeStore(files) {
  const store = { files: { ...files }, reverts: 0, applies: 0 };
  store.applyEdit = async (edit) => {
    store.applies++;
    const content = store.files[edit.file];
    if (content === undefined) return { ok: false, reason: 'no such file' };
    const count = content.split(edit.oldString).length - 1;
    if (count !== 1) return { ok: false, reason: `old text ${count === 0 ? 'not found' : 'not unique'}` };
    store.files[edit.file] = content.replace(edit.oldString, edit.newString);
    return { ok: true, previousContent: content };
  };
  store.revertEdit = async (edit, applyResult) => { store.reverts++; store.files[edit.file] = applyResult.previousContent; };
  return store;
}

test('applyOneFix requires confirmation before any write', async () => {
  const store = makeStore({ 'a.js': 'const x = 1;' });
  const finding = { id: 'f0', stance: 'agree', edit: { file: 'a.js', oldString: '1', newString: '2' } };
  const r = await applyOneFix(finding, store, { confirmed: false });
  assert.equal(r.applied, false);
  assert.match(r.reason, /confirmation/);
  assert.equal(store.applies, 0);
  assert.equal(store.files['a.js'], 'const x = 1;');
});

test('applyOneFix skips non-agree stances and findings without an edit', async () => {
  const store = makeStore({ 'a.js': 'x' });
  const disagree = await applyOneFix({ id: 'f0', stance: 'disagree' }, store, { confirmed: true });
  assert.deepEqual(disagree, { id: 'f0', applied: false, reason: 'stance is "disagree", not agree' });
  const noEdit = await applyOneFix({ id: 'f1', stance: 'agree' }, store, { confirmed: true });
  assert.equal(noEdit.applied, false);
  assert.match(noEdit.reason, /no exact-replace edit/);
});

test('applyOneFix applies a confirmed agree finding when no test command is configured', async () => {
  const store = makeStore({ 'a.js': 'const x = 1;' });
  const finding = { id: 'f0', stance: 'agree', edit: { file: 'a.js', oldString: 'x = 1', newString: 'x = 2' } };
  const r = await applyOneFix(finding, store, { confirmed: true });
  assert.deepEqual(r, { id: 'f0', applied: true });
  assert.equal(store.files['a.js'], 'const x = 2;');
});

test('applyOneFix is idempotent: re-applying an already-applied edit degrades to a skip, never a double-apply', async () => {
  const store = makeStore({ 'a.js': 'const x = 1;' });
  const finding = { id: 'f0', stance: 'agree', edit: { file: 'a.js', oldString: 'x = 1', newString: 'x = 2' } };
  const first = await applyOneFix(finding, store, { confirmed: true });
  const second = await applyOneFix(finding, store, { confirmed: true });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.match(second.reason, /not found/);
  assert.equal(store.files['a.js'], 'const x = 2;'); // unchanged by the second, no-op call
});

test('applyOneFix reverts an edit whose test run regresses', async () => {
  const store = makeStore({ 'a.js': 'const x = 1;' });
  const finding = { id: 'f0', stance: 'agree', edit: { file: 'a.js', oldString: 'x = 1', newString: 'x = 2' } };
  const runTests = async () => ({ passed: false, output: '1 failing' });
  const r = await applyOneFix(finding, { ...store, runTests }, { confirmed: true, testsCommand: 'npm test' });
  assert.deepEqual(r, { id: 'f0', applied: false, reverted: true, reason: 'reverted — tests regressed after this edit' });
  assert.equal(store.files['a.js'], 'const x = 1;'); // restored to the exact original bytes
  assert.equal(store.reverts, 1);
});

test('applyFixes processes a batch in order; one regression reverts only that finding', async () => {
  const store = makeStore({ 'a.js': 'const x = 1;', 'b.js': 'const y = 1;' });
  let calls = 0;
  const runTests = async () => { calls++; return { passed: calls !== 1 }; }; // first file's test run fails, second passes
  const findings = [
    { id: 'f0', stance: 'agree', edit: { file: 'a.js', oldString: 'x = 1', newString: 'x = 2' } },
    { id: 'f1', stance: 'agree', edit: { file: 'b.js', oldString: 'y = 1', newString: 'y = 2' } },
  ];
  const results = await applyFixes(findings, { ...store, runTests }, { confirmed: true, testsCommand: 'npm test' });
  assert.equal(results[0].reverted, true);
  assert.equal(results[1].applied, true);
  assert.equal(store.files['a.js'], 'const x = 1;');
  assert.equal(store.files['b.js'], 'const y = 2;');
});

// --- buildFpCandidate ---

test('buildFpCandidate shapes a disagree stance into memory.mjs\'s needsHuman contract', () => {
  const finding = { title: 'Missing null check', file: 'src/util.js', line: 10 };
  const response = { id: 'f1', stance: 'disagree', evidence: 'guard at src/util.js:8 already covers this' };
  const cand = buildFpCandidate(response, finding);
  assert.equal(cand.file, 'src/util.js');
  assert.equal(cand.evidence, response.evidence);
  assert.match(cand.question, /Missing null check/);
  assert.match(cand.question, /src\/util\.js:10/);
});

// --- CLI smoke tests ---

test('CLI find: locates the latest report and parses its findings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const runDir = join(dir, '.adversarial-code-review', 'review-2026-07-09', 'review-1');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'review.md'), [
      '## Important', '',
      '- **Leftover debug log** (D2 · trusted) — `src/x.js:3` _(conf 85)_',
      '  - evidence: console.log left in',
    ].join('\n'));

    const r = spawnSync(process.execPath, [RESPOND, 'find', '--dir', join(dir, '.adversarial-code-review')], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.folderPath, runDir);
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0].file, 'src/x.js');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI find: degrades to folderPath:null with a note when nothing has been reviewed yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const r = spawnSync(process.execPath, [RESPOND, 'find', '--dir', join(dir, '.adversarial-code-review')], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.folderPath, null);
    assert.ok(out.notes.some((n) => /run \/review first/.test(n)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI apply: writes the edit, then is idempotent on a second identical call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const file = join(dir, 'a.js');
    writeFileSync(file, 'const x = 1;\n');
    const input = JSON.stringify({ id: 'f0', stance: 'agree', confirmed: true, edit: { file, oldString: 'x = 1', newString: 'x = 2' } });

    const first = spawnSync(process.execPath, [RESPOND, 'apply'], { input, encoding: 'utf8', cwd: dir });
    assert.equal(first.status, 0);
    assert.equal(JSON.parse(first.stdout).applied, true);
    assert.equal(readFileSync(file, 'utf8'), 'const x = 2;\n');

    const second = spawnSync(process.execPath, [RESPOND, 'apply'], { input, encoding: 'utf8', cwd: dir });
    assert.equal(second.status, 0);
    const out2 = JSON.parse(second.stdout);
    assert.equal(out2.applied, false);
    assert.equal(readFileSync(file, 'utf8'), 'const x = 2;\n'); // untouched by the no-op re-run
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI record: folds disagree responses into learnings.json as FP candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const input = JSON.stringify({
      responses: [
        { id: 'f0', stance: 'agree', evidence: 'confirmed' },
        { id: 'f1', stance: 'disagree', evidence: 'refuted at src/util.js:8' },
      ],
      findings: [
        { id: 'f0', title: 'A', file: 'src/a.js', line: 1 },
        { id: 'f1', title: 'Missing null check', file: 'src/util.js', line: 10 },
      ],
    });
    const r = spawnSync(process.execPath, [RESPOND, 'record'], { input, encoding: 'utf8', cwd: dir });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.recorded, 1);
    const learnings = JSON.parse(readFileSync(join(dir, out.store), 'utf8'));
    assert.equal(learnings.unresolved.length, 1);
    assert.match(learnings.unresolved[0].question, /Missing null check/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI scope: reports a clean, attached-branch tree as unblocked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    git('add', '.'); git('commit', '-qm', 'init');

    const r = spawnSync(process.execPath, [RESPOND, 'scope', '--fix'], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { dirty: false, detachedHead: false, blocked: false, reason: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI scope: blocks --fix on a dirty tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-respond-cli-'));
  try {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), '1\n');
    git('add', '.'); git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'a.txt'), '2\n'); // uncommitted change → dirty

    const r = spawnSync(process.execPath, [RESPOND, 'scope', '--fix'], { cwd: dir, encoding: 'utf8' });
    const out = JSON.parse(r.stdout);
    assert.equal(out.dirty, true);
    assert.equal(out.blocked, true);
    assert.match(out.reason, /dirty/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI validate: exits 0 for a well-formed batch, 1 for a malformed one', () => {
  const good = JSON.stringify({ responses: [{ id: 'f0', stance: 'agree', evidence: 'confirmed at src/a.js:1' }] });
  const r1 = spawnSync(process.execPath, [RESPOND, 'validate'], { input: good, encoding: 'utf8' });
  assert.equal(r1.status, 0);
  assert.equal(JSON.parse(r1.stdout).valid, true);

  const bad = JSON.stringify({ responses: [{ id: 'f0', stance: 'maybe', evidence: '' }] });
  const r2 = spawnSync(process.execPath, [RESPOND, 'validate'], { input: bad, encoding: 'utf8' });
  assert.equal(r2.status, 1);
  assert.equal(JSON.parse(r2.stdout).valid, false);
});
