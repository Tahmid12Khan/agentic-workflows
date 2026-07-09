// Unit tests for test-signal.mjs — the executed-test signal (S6.4). Pure functions, plus CLI-level
// coverage of the untrusted-config guard (--diff): a PR that edits tests.command in the reviewed
// range must not get it executed. Other pass/fail fixture cases live in tests/cli.test.mjs. Zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFailingTests, testSignal, diffModifiesConfig } from '../lib/test-signal.mjs';

const node = process.execPath;
const SCRIPT = new URL('../lib/test-signal.mjs', import.meta.url).pathname;

const diffFor = (path) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;
const UNRELATED_DIFF = diffFor('lib/foo.mjs');
const CURRENT_CONFIG_DIFF = diffFor('.adversarial-code-review/config.json');
const LEGACY_CONFIG_DIFF = diffFor('.adverserial-code-review/config.json');

test('parseFailingTests extracts node:test / TAP failing names', () => {
  const out = parseFailingTests('ok 1 - passes\nnot ok 2 - handles null input\nnot ok 3 - rejects bad token\n');
  assert.deepEqual(out, ['handles null input', 'rejects bad token']);
});

test('parseFailingTests extracts jest, pytest and go names, de-duped + capped', () => {
  assert.deepEqual(parseFailingTests('  ✕ renders header (12 ms)\n  ✓ renders footer'), ['renders header']);
  assert.deepEqual(parseFailingTests('FAILED tests/test_pay.py::test_refund\nFAILED tests/test_pay.py::test_cap'), ['tests/test_pay.py::test_refund', 'tests/test_pay.py::test_cap']);
  assert.deepEqual(parseFailingTests('--- FAIL: TestRefund (0.00s)\n--- FAIL: TestRefund (0.00s)'), ['TestRefund']); // de-dup
  const many = Array.from({ length: 30 }, (_, i) => `not ok ${i} - t${i}`).join('\n');
  assert.equal(parseFailingTests(many).length, 20); // capped
});

test('parseFailingTests returns [] on unrecognised output', () => {
  assert.deepEqual(parseFailingTests('everything is fine'), []);
  assert.deepEqual(parseFailingTests(''), []);
});

test('testSignal envelope: not-run has passed:null and no failing names', () => {
  const s = testSignal({ ran: false, notes: ['not configured'] });
  assert.deepEqual(s, { ran: false, passed: null, command: null, failing: [], notes: ['not configured'] });
});

test('testSignal envelope: passed run carries no failing names even if output has noise', () => {
  const s = testSignal({ ran: true, passed: true, command: 'npm test', output: 'not ok 1 - stale line' });
  assert.equal(s.passed, true);
  assert.deepEqual(s.failing, []); // failing names only parsed on a FAIL
});

test('testSignal envelope: failed run parses failing names from output', () => {
  const s = testSignal({ ran: true, passed: false, command: 'npm test', output: 'not ok 1 - boom\n' });
  assert.equal(s.ran, true);
  assert.equal(s.passed, false);
  assert.deepEqual(s.failing, ['boom']);
});

test('diffModifiesConfig: true for the current config path, false for an unrelated file', () => {
  assert.equal(diffModifiesConfig(CURRENT_CONFIG_DIFF), true);
  assert.equal(diffModifiesConfig(UNRELATED_DIFF), false);
});

test('diffModifiesConfig: true for the legacy .adverserial-code-review spelling', () => {
  assert.equal(diffModifiesConfig(LEGACY_CONFIG_DIFF), true);
});

test('diffModifiesConfig: false on empty / unrelated input', () => {
  assert.equal(diffModifiesConfig(''), false);
  assert.equal(diffModifiesConfig(undefined), false);
});

// --- CLI-level: the untrusted-config guard (--diff) ---

function mkRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'acr-ts-guard-'));
  mkdirSync(join(cwd, '.adversarial-code-review'), { recursive: true });
  return cwd;
}

// Command has an observable side effect (writes a sentinel file) so we can prove it did/didn't run,
// rather than trusting only the JSON envelope.
const SENTINEL = 'sentinel.txt';
function writeConfig(cwd) {
  const command = `${JSON.stringify(node)} -e "require('fs').writeFileSync('${SENTINEL}', 'ran')"`;
  writeFileSync(join(cwd, '.adversarial-code-review', 'config.json'), JSON.stringify({ tests: { command } }));
}
function writeDiff(cwd, text) {
  const p = join(cwd, 'diff.txt');
  writeFileSync(p, text);
  return p;
}
function runTS(cwd, args = []) {
  return JSON.parse(execFileSync(node, [SCRIPT, ...args], { cwd, encoding: 'utf8' }));
}

test('test-signal.mjs --diff: skips execution when the diff modifies .adversarial-code-review/config.json', () => {
  const cwd = mkRepo();
  try {
    writeConfig(cwd);
    const diffPath = writeDiff(cwd, CURRENT_CONFIG_DIFF);
    const out = runTS(cwd, ['--diff', diffPath]);
    assert.equal(out.ran, false);
    assert.equal(out.passed, null);
    assert.ok(out.notes.some((n) => /untrusted-config guard/.test(n)));
    assert.equal(existsSync(join(cwd, SENTINEL)), false); // command never executed
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('test-signal.mjs --diff: skips execution for the legacy .adverserial-code-review spelling too', () => {
  const cwd = mkRepo();
  try {
    writeConfig(cwd);
    const diffPath = writeDiff(cwd, LEGACY_CONFIG_DIFF);
    const out = runTS(cwd, ['--diff', diffPath]);
    assert.equal(out.ran, false);
    assert.ok(out.notes.some((n) => /untrusted-config guard/.test(n)));
    assert.equal(existsSync(join(cwd, SENTINEL)), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('test-signal.mjs --diff: runs the command as normal when the diff does not touch config', () => {
  const cwd = mkRepo();
  try {
    writeConfig(cwd);
    const diffPath = writeDiff(cwd, UNRELATED_DIFF);
    const out = runTS(cwd, ['--diff', diffPath]);
    assert.equal(out.ran, true);
    assert.equal(out.passed, true);
    assert.equal(existsSync(join(cwd, SENTINEL)), true); // command executed
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('test-signal.mjs: without --diff, behavior is unchanged (executes the configured command)', () => {
  const cwd = mkRepo();
  try {
    writeConfig(cwd);
    const out = runTS(cwd); // no --diff
    assert.equal(out.ran, true);
    assert.equal(out.passed, true);
    assert.equal(existsSync(join(cwd, SENTINEL)), true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
