// Unit tests for history.mjs — the deterministic bug-history prior (S6.3). Pure functions only;
// the git-driven CLI is covered by a fixture-repo case in tests/cli.test.mjs. Zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixSubjects, buildHistory, FIX_RE } from '../lib/history.mjs';

test('fixSubjects strips the short sha and keeps only fix/bug/revert subjects', () => {
  const log = [
    'a1b2c3d fix: rounding on refund',
    'deadbee chore: rename var',
    '1234567 revert "bad cap"',
    '89abcde bugfix: null guard',
    'fedcba9 add hotfix for regression window',
    '0000000 docs: tidy readme',
  ].join('\n');
  const out = fixSubjects(log);
  assert.deepEqual(out, ['fix: rounding on refund', 'revert "bad cap"', 'bugfix: null guard', 'add hotfix for regression window']);
});

test('fixSubjects caps + de-dupes, keeps log order (newest first)', () => {
  const log = Array.from({ length: 10 }, (_, i) => `abc123${i} fix: issue ${i}`).join('\n')
    + '\nabc1230 fix: issue 0';   // duplicate subject
  const out = fixSubjects(log, { max: 3 });
  assert.equal(out.length, 3);
  assert.deepEqual(out, ['fix: issue 0', 'fix: issue 1', 'fix: issue 2']);
});

test('fixSubjects tolerates empty / non-string input', () => {
  assert.deepEqual(fixSubjects(''), []);
  assert.deepEqual(fixSubjects(null), []);
  assert.deepEqual(fixSubjects('   '), []);
});

test('FIX_RE matches the signal stems but not lookalikes', () => {
  for (const s of ['fix: x', 'fixes #1', 'bugfix', 'revert x', 'hotfix now', 'regression seen']) assert.ok(FIX_RE.test(s), s);
  for (const s of ['refactor helper', 'debug logging', 'prefix cleanup']) assert.ok(!FIX_RE.test(s), s);
});

test('buildHistory omits files with no matching subjects', () => {
  const out = buildHistory({
    'src/pay.js': 'aaa1111 fix: rounding\nbbb2222 chore: fmt',
    'src/util.js': 'ccc3333 refactor: split\nddd4444 style: spaces',   // no fix history
    'src/new.js': '',                                                  // brand-new file, no log
  });
  assert.deepEqual(Object.keys(out), ['src/pay.js']);
  assert.deepEqual(out['src/pay.js'], ['fix: rounding']);
});
