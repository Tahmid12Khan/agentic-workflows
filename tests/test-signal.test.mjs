// Unit tests for test-signal.mjs — the executed-test signal (S6.4). Pure functions only; the
// command-running CLI is covered by trivial pass/fail fixture cases in tests/cli.test.mjs. Zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFailingTests, testSignal } from '../lib/test-signal.mjs';

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
