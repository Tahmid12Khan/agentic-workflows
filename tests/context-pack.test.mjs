// Unit tests for context-pack.mjs — the shared context pack (S2.1 of plan.md): enclosing-def
// expansion, whole-file fallback, import extraction, export detection, and the byte caps.
// Pure functions only; the CLI (git grep for callers) is covered in tests/cli.test.mjs. Zero deps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  numbered, mergeRanges, enclosingDefinition, fileBody,
  parseImports, extractExports, assemblePack, PER_FILE_CAP, TOTAL_CAP,
  definitionSignature, hop2Signature, extractTypeRefs, tsTypeDef, pyTypeDef, typeBoundaryText,
  packStats,
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

// --- hop-2: caller's enclosing definition SIGNATURE (not body) ---
test('definitionSignature stops at the first "{" for a multi-line brace signature', () => {
  const lines = ['function add(', '  a,', '  b,', ') {', '  return a + b;', '}'];
  assert.deepEqual(definitionSignature(lines, 1, 6), [1, 4]); // header only, body excluded
});

test('definitionSignature stops at the first line ending in ":" for Python', () => {
  const lines = ['def foo(x):', '    return x + 1'];
  assert.deepEqual(definitionSignature(lines, 1, 2), [1, 1]);
});

test('definitionSignature falls back to the whole span when neither pattern is found', () => {
  assert.deepEqual(definitionSignature(['const f = () => 1;'], 1, 1), [1, 1]);
});

test('hop2Signature: JS caller — signature of the enclosing function, body excluded', () => {
  const content = 'function outer() {\n  return helper(1);\n}\n';
  const sig = hop2Signature(content, 2); // the call site is line 2
  assert.match(sig, /function outer\(\)/);
  assert.doesNotMatch(sig, /return helper/);
});

test('hop2Signature: TS caller — typed signature line, body excluded', () => {
  const content = 'function outer(x: number): number {\n  return helper(x);\n}\n';
  const sig = hop2Signature(content, 2);
  assert.match(sig, /function outer\(x: number\): number \{/);
  assert.doesNotMatch(sig, /return helper/);
});

test('hop2Signature: Python caller — def header only, body excluded', () => {
  const content = 'def outer():\n    return helper()\n';
  const sig = hop2Signature(content, 2);
  assert.match(sig, /def outer\(\):/);
  assert.doesNotMatch(sig, /return helper/);
});

test('hop2Signature degrades to "" (never throws) when the call site is top-level or out of range', () => {
  assert.equal(hop2Signature('const A = 1;\nconst B = 2;', 1), ''); // no enclosing def
  assert.equal(hop2Signature('', 999), '');                          // out-of-range line, empty file
  assert.equal(hop2Signature(null, 1), '');                          // malformed input
});

// --- type-boundary extraction (TS/Python only; feeds D10/D11 per triage.mjs) ---
test('extractTypeRefs finds PascalCase names and excludes SCREAMING_CASE', () => {
  const names = extractTypeRefs('const x: UserInput = {} as UserInput;\nfunction f(): Promise<Result> {}\nconst MAX = 1;');
  for (const n of ['UserInput', 'Promise', 'Result']) assert.ok(names.includes(n), `missing ${n}`);
  assert.ok(!names.includes('MAX'));
});

test('tsTypeDef finds an interface definition, brace-bounded', () => {
  const lines = 'interface UserInput {\n  name: string;\n}\n\nfunction f() {}\n'.split('\n');
  const [s, e] = tsTypeDef(lines, 'UserInput');
  const text = numbered(lines, s, e);
  assert.match(text, /interface UserInput/);
  assert.match(text, /name: string;/);
  assert.doesNotMatch(text, /function f/);
});

test('tsTypeDef finds a `type X = ...` alias, scanned to its terminating ";"', () => {
  const lines = 'type Foo = {\n  a: number;\n};\n\nconst x = 1;\n'.split('\n');
  const [s, e] = tsTypeDef(lines, 'Foo');
  const text = numbered(lines, s, e);
  assert.match(text, /type Foo = \{/);
  assert.match(text, /a: number;/);
  assert.doesNotMatch(text, /const x/);
});

test('tsTypeDef degrades to null (never throws) on an unterminated/malformed interface', () => {
  const lines = 'interface Broken {\n  name: string;\n// no closing brace\n'.split('\n');
  assert.equal(tsTypeDef(lines, 'Broken'), null);
});

test('pyTypeDef finds a dataclass, folding in the decorator and trimming trailing blanks', () => {
  const lines = '@dataclass\nclass Point:\n    x: int\n    y: int\n\ndef unrelated():\n    pass\n'.split('\n');
  const [s, e] = pyTypeDef(lines, 'Point');
  const text = numbered(lines, s, e);
  assert.match(text, /@dataclass/);
  assert.match(text, /class Point:/);
  assert.match(text, /y: int/);
  assert.doesNotMatch(text, /unrelated/);
});

test('pyTypeDef degrades to null (never throws) when the class name is not found', () => {
  assert.equal(pyTypeDef(['class Other:', '    pass'], 'Missing'), null);
});

test('typeBoundaryText resolves referenced types for TS/Python, headed for D10/D11 downstream', () => {
  const tsContent = 'interface UserInput {\n  name: string;\n}\n';
  const text = typeBoundaryText('user.ts', tsContent, 'const u: UserInput = load();');
  assert.match(text, /interface UserInput/);

  const pyContent = 'class Point:\n    x: int\n    y: int\n';
  const pyText = typeBoundaryText('geo.py', pyContent, 'p: Point = Point(1, 2)');
  assert.match(pyText, /class Point:/);
});

test('typeBoundaryText is a no-op for non-TS/Python files, and on malformed content it degrades to ""', () => {
  assert.equal(typeBoundaryText('user.js', 'interface UserInput {}', 'x: UserInput'), ''); // JS excluded by design
  assert.equal(typeBoundaryText('user.ts', 'interface Broken {\n  name: string;\n', 'x: Broken'), ''); // unterminated → no match
  assert.equal(typeBoundaryText('user.ts', null, 'x: Foo'), ''); // malformed content, never throws
});

// --- assemblePack: hop-2 and type-boundary sections, and the drop-priority order ---
test('assemblePack renders the type-boundary section under its "## for: D10,D11" header', () => {
  const { text } = assemblePack([
    { path: 'x.ts', bodyText: '1| ok', bodyFallback: false, importsText: '', callers: [], typeBoundary: '1| interface Foo {}' },
  ]);
  assert.match(text, /## for: D10,D11/);
  assert.match(text, /interface Foo/);
});

test('assemblePack renders the hop-2 section under its own header', () => {
  const { text } = assemblePack([
    { path: 'x.js', bodyText: '1| ok', bodyFallback: false, importsText: '', callers: [],
      hop2: [{ symbol: 'foo', caller: 'caller.js:3', sigText: '3| function bar() {' }] },
  ]);
  assert.match(text, /hop 2/);
  assert.match(text, /foo <- caller\.js:3/);
  assert.match(text, /function bar/);
});

test('assemblePack per-file cap: hop-2 is dropped before imports/callers/type-boundary', () => {
  const { text, notes } = assemblePack(
    [{
      path: 'x.js', bodyText: 'BODY', bodyFallback: false,
      importsText: 'I'.repeat(20), callers: [{ symbol: 'foo', hits: ['a.js:1'] }],
      typeBoundary: 'T'.repeat(20),
      hop2: [{ symbol: 'foo', caller: 'a.js:1', sigText: 'H'.repeat(200) }], // too big to fit alongside the rest
    }],
    { perFileCap: 300, totalCap: 10000 },
  );
  assert.match(text, /BODY/);
  assert.match(text, /I{20}/);       // imports kept
  assert.match(text, /T{20}/);       // type boundary kept
  assert.doesNotMatch(text, /H{200}/); // hop-2 dropped
  assert.ok(notes.some((n) => /hop-2 callers' signatures omitted \(per-file cap\)/.test(n)));
});

test('assemblePack total cap: hop-2 is dropped first, before falling back to the mandatory body', () => {
  const entries = [{
    path: 'x.js', bodyText: 'BODY', bodyFallback: false, importsText: 'imp', callers: [],
    typeBoundary: '', hop2: [{ symbol: 'foo', caller: 'a.js:1', sigText: 'H'.repeat(500) }],
  }];
  // room for body+imports (79B) but not the ~580B hop-2 signature block
  const { text, notes } = assemblePack(entries, { perFileCap: 10000, totalCap: 100 });
  assert.match(text, /BODY/);
  assert.match(text, /imp/);
  assert.doesNotMatch(text, /H{500}/);
  assert.ok(notes.some((n) => /hop-2 dropped \(total pack cap\)/.test(n)));
});

test('assemblePack total cap: falls back to the mandatory body when even hop-2-free extras overflow', () => {
  const entries = [{
    path: 'x.js', bodyText: 'BODY', bodyFallback: false, importsText: 'I'.repeat(200), callers: [],
    typeBoundary: '', hop2: [],
  }];
  // room for body alone (59B) but not body+imports (~276B)
  const { text, notes } = assemblePack(entries, { perFileCap: 10000, totalCap: 100 });
  assert.match(text, /BODY/);
  assert.doesNotMatch(text, /I{200}/);
  assert.ok(notes.some((n) => /extras dropped \(total pack cap\)/.test(n)));
});

// --- packStats (WS7 S3: the same counts as the stderr log line, exported for --stats-out) ---
test('packStats tallies size + per-section counts across entries', () => {
  const entries = [
    { path: 'a.js', importsText: 'imp', callers: [{ symbol: 'foo', hits: ['b.js:1', 'b.js:2'] }], hop2: [{ symbol: 'foo', caller: 'b.js:1', sigText: 'sig' }], typeBoundary: '' },
    { path: 'b.ts', importsText: '', callers: [], hop2: [], typeBoundary: 'type Foo = {}' },
  ];
  const stats = packStats(entries, 'some pack text');
  assert.deepEqual(stats, { sizeBytes: 14, files: 2, imports: 1, callerHits: 2, hop2: 1, typeBoundary: 1 });
});

test('packStats degrades to zeroes on empty/absent entries', () => {
  assert.deepEqual(packStats([], ''), { sizeBytes: 0, files: 0, imports: 0, callerHits: 0, hop2: 0, typeBoundary: 0 });
  assert.deepEqual(packStats(undefined, undefined), { sizeBytes: 0, files: 0, imports: 0, callerHits: 0, hop2: 0, typeBoundary: 0 });
});
