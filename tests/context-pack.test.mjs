// Unit tests for context-pack.mjs — the shared context pack (S2.1 of plan.md): enclosing-def
// expansion, whole-file fallback, import extraction, export detection, and the byte caps.
// Pure functions only; the CLI (git grep for callers) is covered in tests/cli.test.mjs. Zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numbered, mergeRanges, enclosingDefinition, fileBody,
  parseImports, extractExports, assemblePack, PER_FILE_CAP, TOTAL_CAP,
} from '../lib/context-pack.mjs';

test('numbered prints a 1-indexed line-numbered slice', () => {
  assert.equal(numbered(['a', 'b', 'c'], 2, 3), '2| b\n3| c');
  assert.equal(numbered(['a', 'b'], 1, 99), '1| a\n2| b'); // end clamped to length
});

test('mergeRanges merges overlapping and adjacent ranges', () => {
  assert.deepEqual(mergeRanges([[1, 3], [4, 6], [10, 12]]), [[1, 6], [10, 12]]); // adjacent → merged
  assert.deepEqual(mergeRanges([[5, 8], [1, 3], [2, 6]]), [[1, 8]]);             // overlapping, unsorted
  assert.deepEqual(mergeRanges([]), []);
});

// --- boundary expansion (the core heuristic) ---
test('enclosingDefinition: a change inside a brace function returns the whole function', () => {
  const lines = [
    'export function foo() {', //1
    '  const x = 1;',          //2
    '  return x + 1;',         //3  <- change
    '}',                       //4
    '',                        //5
    'export function bar() {', //6
    '  return 2;',             //7
    '}',                       //8
  ];
  assert.deepEqual(enclosingDefinition(lines, 3, 3), [1, 4]); // just foo, not bar
});

test('enclosingDefinition: a multi-line signature above the { is folded in', () => {
  const lines = ['function add(', '  a,', '  b,', ') {', '  return a + b;', '}'];
  assert.deepEqual(enclosingDefinition(lines, 5, 5), [1, 6]);
});

test('enclosingDefinition: a nested method returns the method, not the enclosing class', () => {
  const lines = ['class Foo {', '  x = 1;', '', '  bar() {', '    return this.x;', '  }', '}'];
  assert.deepEqual(enclosingDefinition(lines, 5, 5), [4, 6]);
});

test('enclosingDefinition: Python def is bounded by indentation and folds in decorators', () => {
  const lines = ['import os', '', '@decorator', 'def foo(x):', '    y = x + 1', '    return y', '', 'def bar():', '    return 2'];
  assert.deepEqual(enclosingDefinition(lines, 5, 5), [3, 6]); // decorator..last body line, no trailing blank/next def
});

test('enclosingDefinition: a top-level change with no enclosing def returns null (→ whole-file fallback)', () => {
  assert.equal(enclosingDefinition(['const A = 1;', 'const B = 2;'], 1, 1), null);
});

// --- fileBody: def spans vs whole-file fallback ---
test('fileBody: emits the enclosing definition, line-numbered, when a boundary is found', () => {
  const content = 'export function foo() {\n  const x = 1;\n  return x;\n}\n\nexport function bar() {\n  return 2;\n}\n';
  const { bodyText, fallback } = fileBody(content, [[3, 3]]);
  assert.equal(fallback, false);
  assert.match(bodyText, /1\| export function foo\(\)/);
  assert.match(bodyText, /3\|\s+return x;/);
  assert.doesNotMatch(bodyText, /function bar/); // sibling def excluded
});

test('fileBody: falls back to the whole file when no definition boundary is found', () => {
  const { bodyText, fallback } = fileBody('const A = 1;\nconst B = 2;', [[1, 1]]);
  assert.equal(fallback, true);
  assert.match(bodyText, /1\| const A = 1;/);
  assert.match(bodyText, /2\| const B = 2;/);
});

test('fileBody: an over-cap whole-file fallback is windowed around the change (changed line survives)', () => {
  const content = Array.from({ length: 50 }, (_, i) => `const v${i} = ${i};`).join('\n'); // no braces/defs
  const { bodyText, fallback } = fileBody(content, [[25, 25]], { perFileCap: 100, windowRadius: 2 });
  assert.equal(fallback, true);
  assert.match(bodyText, /25\| const v24 = 24;/);   // the changed line is always kept
  assert.doesNotMatch(bodyText, /const v0 = 0;/);    // far-away lines dropped to fit the cap
});

// --- imports + exports ---
test('parseImports extracts the top import block (skipping shebang/comments), else empty', () => {
  const content = '#!/usr/bin/env node\n// header\nimport a from "a";\nimport b from "b";\n\nexport const x = 1;\n';
  const imports = parseImports(content);
  assert.match(imports, /import a from "a";/);
  assert.match(imports, /import b from "b";/);
  assert.doesNotMatch(imports, /export const x/);
  assert.equal(parseImports('const x = 1;'), '');
});

test('extractExports finds named, default, brace-list and CommonJS exports', () => {
  const names = extractExports('export function foo() {}\nexport const bar = 1;\nexport { a, b as c };\nmodule.exports.qux = 1;');
  for (const n of ['foo', 'bar', 'a', 'c', 'qux']) assert.ok(names.includes(n), `missing ${n}`);
});

// --- assemblePack: header + caps ---
test('assemblePack prepends the DATA-not-instructions header and includes the body', () => {
  const { text } = assemblePack([{ path: 'x.js', bodyText: '1| ok', bodyFallback: false, importsText: '', callers: [] }]);
  assert.match(text, /CONTEXT PACK/);
  assert.match(text, /DATA under review/);
  assert.match(text, /===== FILE: x\.js =====/);
  assert.match(text, /1\| ok/);
  assert.equal(assemblePack([]).text, ''); // nothing changed → empty pack
});

test('assemblePack drops extras (imports/callers) to fit the per-file cap, keeping the body + a note', () => {
  const { text, notes } = assemblePack(
    [{ path: 'x.js', bodyText: 'BODY', bodyFallback: false, importsText: 'I'.repeat(500), callers: [{ symbol: 'foo', hits: ['a.js:1'] }] }],
    { perFileCap: 120, totalCap: 10000 },
  );
  assert.match(text, /BODY/);                                    // mandatory body kept
  assert.ok(notes.some((n) => /imports omitted \(per-file cap\)/.test(n)));
});

test('assemblePack omits tail files once the total cap is hit, with a note', () => {
  const big = 'X'.repeat(400);
  const entries = [
    { path: 'a.js', bodyText: big, bodyFallback: false, importsText: '', callers: [] },
    { path: 'b.js', bodyText: big, bodyFallback: false, importsText: '', callers: [] },
  ];
  const { text, notes } = assemblePack(entries, { perFileCap: 1000, totalCap: 500 });
  assert.match(text, /FILE: a\.js/);
  assert.doesNotMatch(text, /FILE: b\.js/);
  assert.ok(notes.some((n) => /b\.js: omitted \(total pack cap 500B reached\)/.test(n)));
});

test('caps are the plan-mandated 40KB total / 8KB per file', () => {
  assert.equal(TOTAL_CAP, 40 * 1024);
  assert.equal(PER_FILE_CAP, 8 * 1024);
});
