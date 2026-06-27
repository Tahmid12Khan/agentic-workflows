import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterDiff, normPath } from '../lib/trim-diff.mjs';

// A realistic 3-file unified diff: a modify, a new file, and a deletion.
const DIFF = `diff --git a/lib/foo.mjs b/lib/foo.mjs
index 1111111..2222222 100644
--- a/lib/foo.mjs
+++ b/lib/foo.mjs
@@ -1,4 +1,5 @@
 export function foo() {
-  return 1;
+  // changed
+  return 2;
 }
 // tail context
diff --git a/lib/bar.mjs b/lib/bar.mjs
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/lib/bar.mjs
@@ -0,0 +1,2 @@
+export const bar = 1;
+export const baz = 2;
diff --git a/lib/gone.mjs b/lib/gone.mjs
deleted file mode 100644
index 4444444..0000000
--- a/lib/gone.mjs
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-// removed
`;

test('keeps only the requested file section, full hunk context preserved', () => {
  const out = filterDiff(DIFF, ['lib/foo.mjs']);
  assert.match(out, /diff --git a\/lib\/foo\.mjs/);
  assert.doesNotMatch(out, /lib\/bar\.mjs/);
  assert.doesNotMatch(out, /lib\/gone\.mjs/);
  // every context + changed line of the kept hunk survives (no partial-line cut)
  assert.match(out, /export function foo\(\)/);
  assert.match(out, /\+  return 2;/);
  assert.match(out, /\/\/ tail context/);
});

test('keeps multiple requested sections and only those', () => {
  const out = filterDiff(DIFF, ['lib/foo.mjs', 'lib/gone.mjs']);
  assert.match(out, /lib\/foo\.mjs/);
  assert.match(out, /lib\/gone\.mjs/);
  assert.doesNotMatch(out, /lib\/bar\.mjs/);
  assert.match(out, /-export const gone = true;/);
});

test('matches a new file via its +++ path (--- is /dev/null)', () => {
  const out = filterDiff(DIFF, ['lib/bar.mjs']);
  assert.match(out, /lib\/bar\.mjs/);
  assert.match(out, /\+export const bar = 1;/);
  assert.doesNotMatch(out, /lib\/foo\.mjs/);
});

test('matches a deleted file via its --- path (+++ is /dev/null)', () => {
  const out = filterDiff(DIFF, ['lib/gone.mjs']);
  assert.match(out, /lib\/gone\.mjs/);
  assert.doesNotMatch(out, /lib\/foo\.mjs/);
});

test('accepts a/ b/-prefixed file paths too', () => {
  const out = filterDiff(DIFF, ['b/lib/foo.mjs']);
  assert.match(out, /lib\/foo\.mjs/);
  assert.doesNotMatch(out, /lib\/bar\.mjs/);
});

test('SAFETY: a path-format mismatch falls back to the full diff (never drop everything)', () => {
  const out = filterDiff(DIFF, ['does/not/exist.mjs']);
  assert.equal(out, DIFF);
});

test('SAFETY: empty file list returns the full diff', () => {
  assert.equal(filterDiff(DIFF, []), DIFF);
  assert.equal(filterDiff(DIFF, undefined), DIFF);
});

test('SAFETY: non-diff input returns unchanged', () => {
  assert.equal(filterDiff('not a diff at all', ['x']), 'not a diff at all');
  assert.equal(filterDiff('', ['x']), '');
});

test('reconstructed slice is itself a valid concatenation (re-filtering is stable)', () => {
  const once = filterDiff(DIFF, ['lib/foo.mjs', 'lib/bar.mjs']);
  const twice = filterDiff(once, ['lib/foo.mjs', 'lib/bar.mjs']);
  assert.equal(twice, once);
});

test('normPath strips a/ b/ prefix and trailing tab metadata', () => {
  assert.equal(normPath('a/lib/foo.mjs'), 'lib/foo.mjs');
  assert.equal(normPath('b/lib/foo.mjs'), 'lib/foo.mjs');
  assert.equal(normPath('lib/foo.mjs\t2026-01-01'), 'lib/foo.mjs');
  assert.equal(normPath(undefined), '');
});
