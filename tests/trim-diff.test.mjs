import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterDiff, stripNoise, NOISE_RE, normPath, buildDiffIndex, splitByFile } from '../lib/trim-diff.mjs';

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

// A diff mixing real source with mechanically-generated noise (a lockfile + a build artifact).
const NOISY = `diff --git a/lib/foo.mjs b/lib/foo.mjs
index 1111111..2222222 100644
--- a/lib/foo.mjs
+++ b/lib/foo.mjs
@@ -1,2 +1,2 @@
 export function foo() {
-  return 1;
+  return 2;
 }
diff --git a/package-lock.json b/package-lock.json
index 3333333..4444444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,3 +1,3 @@
 {
-  "version": "1.0.0",
+  "version": "1.0.1",
 }
diff --git a/dist/bundle.min.js b/dist/bundle.min.js
index 5555555..6666666 100644
--- a/dist/bundle.min.js
+++ b/dist/bundle.min.js
@@ -1 +1 @@
-var a=1;
+var a=2;
`;

test('stripNoise drops lockfile + build-artifact sections, keeps source verbatim', () => {
  const out = stripNoise(NOISY);
  assert.match(out, /lib\/foo\.mjs/);
  assert.match(out, /\+  return 2;/);          // full source hunk preserved
  assert.doesNotMatch(out, /package-lock\.json/);
  assert.doesNotMatch(out, /dist\/bundle\.min\.js/);
});

test('stripNoise never touches a real test or config source hunk', () => {
  // tests/specs and .json config (other than package-lock) are NOT noise — they must survive.
  assert.equal(NOISE_RE.test('tests/foo.test.mjs'), false);
  assert.equal(NOISE_RE.test('src/config.json'), false);
  assert.equal(NOISE_RE.test('config/settings.yaml'), false);
});

test('SAFETY: stripNoise returns the original when nothing is noise (stable)', () => {
  assert.equal(stripNoise(DIFF), DIFF);
});

test('SAFETY: an all-noise diff falls back to the full diff (never drop everything)', () => {
  const allNoise = `diff --git a/yarn.lock b/yarn.lock
index 1..2 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1 +1 @@
-foo@1.0.0
+foo@1.0.1
`;
  assert.equal(stripNoise(allNoise), allNoise);
});

test('SAFETY: stripNoise on non-diff / empty input returns unchanged', () => {
  assert.equal(stripNoise('not a diff at all'), 'not a diff at all');
  assert.equal(stripNoise(''), '');
  assert.equal(stripNoise(undefined), undefined);
});

test('stripNoise output re-filters stably (idempotent)', () => {
  const once = stripNoise(NOISY);
  assert.equal(stripNoise(once), once);
});

test('normPath strips a/ b/ prefix and trailing tab metadata', () => {
  assert.equal(normPath('a/lib/foo.mjs'), 'lib/foo.mjs');
  assert.equal(normPath('b/lib/foo.mjs'), 'lib/foo.mjs');
  assert.equal(normPath('lib/foo.mjs\t2026-01-01'), 'lib/foo.mjs');
  assert.equal(normPath(undefined), '');
});

test('buildDiffIndex maps files to their new-side changed line ranges (multi-hunk)', () => {
  const diff = [
    'diff --git a/src/foo.js b/src/foo.js',
    'index 111..222 100644',
    '--- a/src/foo.js',
    '+++ b/src/foo.js',
    '@@ -10,3 +10,4 @@ function foo() {',
    ' ctx', '+added', ' ctx', ' ctx',
    '@@ -40,2 +41,2 @@',
    '-old', '+new', ' ctx', '',
  ].join('\n');
  assert.deepEqual(buildDiffIndex(diff)['src/foo.js'], [[10, 13], [41, 42]]);
});

test('buildDiffIndex: no-count hunk = one line; deleted file keeps an empty range list', () => {
  const diff = [
    'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js',
    '@@ -5 +5 @@', '-x', '+y',
    'diff --git a/gone.js b/gone.js', 'deleted file mode 100644', '--- a/gone.js', '+++ /dev/null',
    '@@ -1,3 +0,0 @@', '-a', '-b', '-c', '',
  ].join('\n');
  const idx = buildDiffIndex(diff);
  assert.deepEqual(idx['a.js'], [[5, 5]]);   // "@@ +5 @@" → single line
  assert.deepEqual(idx['gone.js'], []);      // deletion: path present (in changed set), no new-side lines
});

test('buildDiffIndex returns {} for empty / non-diff / null input (never throws)', () => {
  assert.deepEqual(buildDiffIndex(''), {});
  assert.deepEqual(buildDiffIndex('not a diff'), {});
  assert.deepEqual(buildDiffIndex(null), {});
});

test('splitByFile maps each changed file to its complete, verbatim diff section', () => {
  const diff =
    'diff --git a/src/foo.js b/src/foo.js\n--- a/src/foo.js\n+++ b/src/foo.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\n' +
    'diff --git a/src/bar.js b/src/bar.js\n--- a/src/bar.js\n+++ b/src/bar.js\n@@ -5 +5 @@\n-x\n+y\n';
  const out = splitByFile(diff);
  assert.deepEqual(Object.keys(out).sort(), ['src/bar.js', 'src/foo.js']);
  assert.match(out['src/foo.js'], /^diff --git a\/src\/foo\.js/);
  assert.match(out['src/foo.js'], /\+c\n/);
  assert.doesNotMatch(out['src/foo.js'], /bar\.js/);   // one file's section never leaks another's hunks
  // reassembling the sections reproduces the whole diff (no bytes lost)
  assert.equal(out['src/foo.js'] + out['src/bar.js'], diff);
});

test('splitByFile: a deleted file keys on its old path; empty / non-diff / null → {} (never throws)', () => {
  const del = 'diff --git a/gone.js b/gone.js\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n';
  assert.deepEqual(Object.keys(splitByFile(del)), ['gone.js']);
  assert.deepEqual(splitByFile(''), {});
  assert.deepEqual(splitByFile('not a diff'), {});
  assert.deepEqual(splitByFile(null), {});
});
