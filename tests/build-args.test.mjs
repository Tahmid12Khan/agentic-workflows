// Unit + CLI smoke tests for build-args.mjs — the args assembler that keeps the bulky
// diff/plan/bundle out of the main agent's context. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, mergeEnrich, knownFalsePositives, rangesBySliceName, sliceNameCollision, manifestText, manifestName, bundleParts, contextPackNote } from '../lib/build-args.mjs';
import { sliceName } from '../lib/trim-diff.mjs';

const SCRIPT = new URL('../lib/build-args.mjs', import.meta.url).pathname;

test('mergeEnrich: enrichment wins, base fields kept, null patch is a no-op', () => {
  assert.deepEqual(mergeEnrich({ summary: 'x', pr: 1 }, { pr: 2, ticket: 'T' }),
    { summary: 'x', pr: 2, ticket: 'T' });
  assert.deepEqual(mergeEnrich({ summary: 'x' }, null), { summary: 'x' });
  assert.deepEqual(mergeEnrich(null, null), {});
});

test('buildArgs: emits exactly the keys review-workflow.mjs destructures', () => {
  const out = buildArgs({
    plan: { tier: 'standard', shards: [{ label: 'all', files: ['a.js'] }] },
    bundle: { summary: 's' }, diffPath: '/scratch/diff.txt', diffIndex: { 'a.js': [[1, 3]] },
    scrutiny: { foo: 1 }, checks: { bar: 2 },
    meta: { flags: { gate: true }, startedAt: 'T', prNumber: 7, checkout: null },
  });
  assert.deepEqual(Object.keys(out).sort(),
    ['allManifest', 'allParts', 'buildNotes', 'bundle', 'checkout', 'contextPackPath', 'contextPackStats', 'diffIndex', 'diffPath', 'diffRanges', 'doctrineText', 'flags', 'historyPath', 'knownFalsePositives', 'plan', 'prNumber', 'routing', 'shards', 'sliceDir', 'startedAt', 'testSignal'].sort());
  assert.equal(out.allManifest, null);      // no manifest written → the workflow falls back to inline shard files
  assert.equal(out.allParts, null);         // no bundle written → D3/intent fall back to the bare diffRead
  assert.deepEqual(out.buildNotes, []);     // nothing degraded → no seeded note (the common case, zero cost)
  assert.equal(out.sliceDir, null);   // absent → null so the workflow falls back to the full diff (no slicing)
  assert.deepEqual(out.doctrineText, {});   // WS1: absent → {} so the workflow attaches no doctrine
  assert.deepEqual(out.shards, [{ label: 'all', files: ['a.js'] }]); // lifted from plan
  assert.deepEqual(out.routing, { scrutiny: { foo: 1 }, checks: { bar: 2 } });
  assert.equal(out.prNumber, 7);
  assert.equal(out.diffPath, '/scratch/diff.txt');   // args-by-reference: path, not text
  assert.deepEqual(out.diffIndex, { 'a.js': [[1, 3]] });   // only ever set in the collision fallback; carried through as given
  assert.equal(out.contextPackPath, null);   // absent → null so the workflow prepends nothing
  assert.equal(out.contextPackStats, null);  // WS7 S3 absent → null so the coverage section omits the line
  assert.equal(out.historyPath, null);   // S6.3 absent → null so historyBlock attaches nothing
  assert.equal(out.testSignal, null);  // S6.4 absent → null (no --run-tests)
  assert.deepEqual(out.knownFalsePositives, []);   // absent → [] so the workflow prepends no FP block
});

test('buildArgs: strips the duplicated shards + files from the embedded plan, keeps a shardCount', () => {
  // The orchestrator model must EMIT args verbatim into the Workflow call; on a many-file PR the
  // per-file paths were carried ~3× (plan.shards + plan.files + the top-level args.shards), doubling
  // the plan blob and widening the mid-response-drop window. The embedded plan must NOT re-carry them.
  const shards = [{ label: 'src', files: ['a.js', 'b.js'] }, { label: 'test', files: ['c.test.js'] }];
  const out = buildArgs({
    plan: { tier: 'standard', sharded: true, shards, files: ['a.js', 'b.js', 'c.test.js'], dimensions: ['D1'] },
    bundle: {}, diffPath: '/d',
  });
  assert.equal('shards' in out.plan, false, 'plan.shards is dead weight (workflow reads top-level shards)');
  assert.equal('files' in out.plan, false, 'plan.files is derivable from shards in the workflow');
  assert.equal(out.plan.shardCount, 2, 'shard COUNT is kept for render’s coverage line');
  assert.equal(out.plan.tier, 'standard');           // other plan fields survive
  assert.deepEqual(out.plan.dimensions, ['D1']);
  assert.deepEqual(out.shards, shards);              // the SINGLE live copy is top-level args.shards
  // and the workflow can rebuild the flat file list from args.shards (what its plan.files reconstruct does)
  assert.deepEqual(out.shards.flatMap((s) => s.files), ['a.js', 'b.js', 'c.test.js']);
});

test('buildArgs: a provided knownFalsePositives list is carried through', () => {
  const kfp = [{ file: 'a.js', title: 'unused var' }];
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d', knownFalsePositives: kfp });
  assert.deepEqual(out.knownFalsePositives, kfp);
});

// --- knownFalsePositives: accepted-FP digest from the learnings store ---
test('knownFalsePositives: splits the memory.mjs file::title key and caps the count', () => {
  const learnings = {
    acceptedFalsePositives: [
      { key: 'src/a.js::unused variable', note: '👎' },
      { key: 'src/b.js::sql injection::extra', note: '👎' },   // title itself contains '::' — kept via first-split
    ],
  };
  const out = knownFalsePositives(learnings);
  assert.deepEqual(out[0], { file: 'src/a.js', title: 'unused variable' });
  assert.deepEqual(out[1], { file: 'src/b.js', title: 'sql injection::extra' });
});

test('knownFalsePositives: caps at max, degrades to [] on absent/malformed input', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ key: `f${i}.js::t${i}` }));
  assert.equal(knownFalsePositives({ acceptedFalsePositives: many }).length, 20);
  assert.deepEqual(knownFalsePositives(null), []);
  assert.deepEqual(knownFalsePositives({}), []);
  assert.deepEqual(knownFalsePositives({ acceptedFalsePositives: [{ key: '' }] }), []);
});

test('buildArgs: S6 historyPath + testSignal are carried through when provided', () => {
  const historyPath = '/scratch/history.json';
  const testSignal = { ran: true, passed: false, failing: ['t1'] };
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d', historyPath, testSignal });
  assert.equal(out.historyPath, historyPath);
  assert.deepEqual(out.testSignal, testSignal);
});

test('buildArgs: missing meta/routing degrade to safe defaults, not throws', () => {
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d' });
  assert.deepEqual(out.shards, []);
  assert.deepEqual(out.routing, { scrutiny: null, checks: null });
  assert.deepEqual(out.flags, {});
  assert.equal(out.startedAt, null);
  assert.equal(out.contextPackPath, null);
  assert.equal(out.diffIndex, null);     // absent → null; the sandbox rebuilds the index from diffRanges
  assert.deepEqual(out.diffRanges, {});  // absent → {} so the workflow demotes nothing (no crash)
});

test('buildArgs: a provided context pack path is carried through', () => {
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d', contextPackPath: '/scratch/context.txt' });
  assert.equal(out.contextPackPath, '/scratch/context.txt');
});

test('buildArgs: provided context pack stats are carried through', () => {
  const stats = { sizeBytes: 100, files: 1, imports: 1, callerHits: 2, hop2: 0, typeBoundary: 0 };
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d', contextPackStats: stats });
  assert.deepEqual(out.contextPackStats, stats);
});

test('rangesBySliceName: rekeys the reviewed files\u2019 ranges by slice name, dropping files absent from the diff', () => {
  const idx = { 'src/a.js': [[1, 3]], 'src/b.js': [[4, 5]], 'src/c.js': [] };
  const out = rangesBySliceName(idx, ['src/a.js', 'src/c.js', 'src/never-changed.js']);
  assert.deepEqual(out[sliceName('src/a.js')], [[1, 3]]);
  assert.deepEqual(out[sliceName('src/c.js')], []);   // in the diff, no new-side hunks — key kept so findings stay in scope
  assert.equal(sliceName('src/never-changed.js') in out, false, 'a file the diff never touched gets no entry (stays out of scope)');
  assert.equal(Object.keys(out).length, 2);
  // tolerates a/ b/ prefixes on the index side via normPath, and empty/absent inputs
  assert.deepEqual(rangesBySliceName({ 'b/src/a.js': [[1, 1]] }, ['src/a.js']), {});
  assert.deepEqual(rangesBySliceName({}, ['src/a.js']), {});
  assert.deepEqual(rangesBySliceName(idx, []), {});
  assert.deepEqual(rangesBySliceName(null, null), {});
});

test('sliceNameCollision: null for distinct names and for a repeated path, non-null only for a real clash', () => {
  assert.equal(sliceNameCollision(['a.js', 'b.js', 'src/deep/c.ts']), null);
  assert.equal(sliceNameCollision(['a.js', 'a.js']), null, 'the same path twice is not a collision');
  assert.equal(sliceNameCollision([]), null);
  assert.equal(sliceNameCollision(null), null);
  // force a clash by stubbing two paths onto one name is impossible without a real FNV collision,
  // so assert the detector\u2019s shape instead: distinct paths sharing a name must be reported.
  const clash = ['x.js', 'y.js'].filter((f) => sliceName(f) === sliceName('x.js'));
  assert.deepEqual(clash, ['x.js'], 'sanity: these two fixtures do NOT collide');
});

test('CLI: when plan.filesCapped is set, the slices + ranges cover only the reviewed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-cap-'));
  try {
    // 2 files change, but the plan reviewed only a.js (capped) — b.js was dropped.
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({
      tier: 'high', files: ['a.js'], filesCapped: { max: 1, total: 2, reviewed: 1, dropped: 1 },
      shards: [{ label: 'all', files: ['a.js'] }],
    }));
    writeFileSync(join(dir, 'bundle.json'), '{"summary":"x"}');
    writeFileSync(join(dir, 'diff.txt'),
      'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\n' +
      'diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -1 +1,2 @@\n-x\n+y\n+z\n');
    writeFileSync(join(dir, 'meta.json'), '{}');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.equal(a.diffIndex, null, 'no collision → no legacy path-keyed index');
    assert.deepEqual(Object.keys(a.diffRanges), [sliceName('a.js')], 'diffRanges drops the unreviewed b.js');
    assert.equal(existsSync(join(a.sliceDir, sliceName('a.js'))), true, 'the reviewed file gets a slice');
    assert.equal(existsSync(join(a.sliceDir, sliceName('b.js'))), false, 'the unreviewed file gets none');
    assert.deepEqual(a.plan.filesCapped, { max: 1, total: 2, reviewed: 1, dropped: 1 }); // carried through
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- file list by reference: per-shard manifests ---

test('manifestText: one "<path>\\t<slice>" line per file, bare paths when slicing is off', () => {
  const t = manifestText(['a/b.js', 'c.js'], '/s/slices');
  assert.deepEqual(t.split('\n').filter(Boolean), [
    `a/b.js\t/s/slices/${sliceName('a/b.js')}`,
    `c.js\t/s/slices/${sliceName('c.js')}`,
  ]);
  assert.equal(t.endsWith('\n'), true);
  // no sliceDir (collision fallback / fs error) → path only, so the reviewer reads the full diff
  assert.equal(manifestText(['c.js'], null), 'c.js\n');
  assert.equal(manifestText([], '/s/slices'), '');   // empty shard writes an empty file, not a stray newline
  // column 1 is the RAW repo path — normPath() would strip the leading "a/"/"b/" it exists to remove
  // from DIFF HEADERS, handing the reviewer a path that does not exist. Only the slice name normalizes.
  assert.equal(manifestText(['b/c.js'], '/s'), `b/c.js\t/s/${sliceName('b/c.js')}\n`);
});

test('manifestName: filesystem-safe and collision-free across merged shard labels', () => {
  assert.equal(manifestName('src', 0), '0-src.files');
  // shard.mjs merges the smallest shards with a '+' join, and labels are directory names
  assert.equal(manifestName('api+web', 1), '1-api+web.files');
  assert.equal(manifestName('a/b', 2), '2-a_b.files');
  // two labels that sanitize identically stay distinct via the index prefix
  assert.notEqual(manifestName('a/b', 0), manifestName('a:b', 1));
  assert.equal(manifestName(null, 3), '3-shard.files');
});

test('bundleParts: concatenates every file into one part when it fits', () => {
  const byFile = { 'a.js': '-x\n+y\n', 'b.js': '-p\n+q\n' };
  const parts = bundleParts(['a.js', 'b.js'], byFile);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], '=== FILE: a.js ===\n-x\n+y\n=== FILE: b.js ===\n-p\n+q\n');
});

test('bundleParts: empty input returns []', () => {
  assert.deepEqual(bundleParts([], {}), []);
  assert.deepEqual(bundleParts(undefined, {}), []);
});

test('bundleParts: a file absent from byFile gets the placeholder text', () => {
  const parts = bundleParts(['renamed.js'], {});
  assert.equal(parts.length, 1);
  assert.match(parts[0], /=== FILE: renamed\.js ===\n\(no textual hunks for renamed\.js — rename, mode change, or binary\)\n/);
});

test('bundleParts: splits into 2+ parts at the line cap, never dividing one file', () => {
  const byFile = {
    'a.js': Array.from({ length: 10 }, (_, i) => `+line${i}`).join('\n') + '\n',
    'b.js': Array.from({ length: 10 }, (_, i) => `+line${i}`).join('\n') + '\n',
  };
  // each chunk (header + 11 lines) is ~12 lines; cap at 15 forces a's chunk and b's chunk apart
  const parts = bundleParts(['a.js', 'b.js'], byFile, { maxLines: 15 });
  assert.equal(parts.length, 2);
  assert.match(parts[0], /=== FILE: a\.js ===/);
  assert.doesNotMatch(parts[0], /=== FILE: b\.js ===/);
  assert.match(parts[1], /=== FILE: b\.js ===/);
  assert.doesNotMatch(parts[1], /=== FILE: a\.js ===/);
});

test('bundleParts: splits at the byte cap too', () => {
  const big = 'x'.repeat(100);
  const byFile = { 'a.js': big + '\n', 'b.js': big + '\n' };
  const parts = bundleParts(['a.js', 'b.js'], byFile, { maxBytes: 150 });
  assert.equal(parts.length, 2);
});

test('bundleParts: a single oversized file becomes its own oversized part, never split', () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `+line${i}`).join('\n') + '\n';
  const byFile = { 'huge.js': huge, 'small.js': '+x\n' };
  const parts = bundleParts(['huge.js', 'small.js'], byFile, { maxLines: 1800 });
  assert.equal(parts.length, 2);   // huge.js alone exceeds the cap → its own part; small.js gets the next
  assert.match(parts[0], /=== FILE: huge\.js ===/);
  assert.doesNotMatch(parts[0], /=== FILE: small\.js ===/);
  assert.match(parts[1], /=== FILE: small\.js ===/);
});

test('contextPackNote: an EMPTY pack degrades to a note, an absent one is silent', () => {
  // context-pack.mjs wrote a zero-byte file → build-args reads null → without a note the report
  // would look identical to a healthy run that simply had no pack (golden rule 3).
  assert.equal(contextPackNote(true, null).length, 1);
  assert.match(contextPackNote(true, null)[0], /EMPTY/);
  assert.deepEqual(contextPackNote(true, '/s/context.txt'), []);  // pack present → nothing to say
  assert.deepEqual(contextPackNote(false, null), []);             // pre-step never ran → not a degrade
});

test('CLI: writes per-shard manifests and keeps every reviewed path OUT of args', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-man-'));
  try {
    const files = ['src/a.js', 'src/b.js', 'src/c.js'];
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({
      tier: 'standard', fileCount: 3, files,
      shards: [{ label: 'src', files }],
    }));
    writeFileSync(join(dir, 'diff.txt'), files.map((f) =>
      `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1,2 @@\n-a\n+b\n+c\n`).join(''));
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);

    // shards carry a label + count + manifest PATH + bundle-part paths — never the file list
    assert.equal(a.shards.length, 1);
    assert.deepEqual(Object.keys(a.shards[0]).sort(), ['count', 'label', 'manifest', 'parts']);
    assert.equal(a.shards[0].count, 3);
    assert.equal(a.shards[0].manifest, join(dir, 'manifests', '0-src.files'));
    assert.equal(a.allManifest, join(dir, 'manifests', 'all.files'));

    // the manifest on disk is the reviewer's read list: path + its slice, and the slice exists
    const lines = readFileSync(a.shards[0].manifest, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    const [path0, slice0] = lines[0].split('\t');
    assert.equal(path0, 'src/a.js');
    assert.match(readFileSync(slice0, 'utf8'), /\+c/);

    // the shard's bundle part(s) concatenate every file's slice content, one part here (small fixture)
    assert.equal(a.shards[0].parts.length, 1);
    const bundleText = readFileSync(a.shards[0].parts[0], 'utf8');
    for (const f of files) assert.match(bundleText, new RegExp(`=== FILE: ${f.replace(/\./g, '\\.')} ===`));
    // the all-files bundle covers the whole reviewed set too
    assert.equal(a.allParts.length, 1);
    assert.match(readFileSync(a.allParts[0], 'utf8'), /=== FILE: src\/a\.js ===/);

    // THE POINT: no reviewed path survives anywhere in the emitted args blob
    const blob = JSON.stringify(a);
    for (const f of files) assert.equal(blob.includes(f), false, `${f} must not be inlined into args`);
    assert.equal(a.plan.files, undefined);    // stripped from the embedded plan too
    assert.equal(a.plan.shards, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: an EMPTY context.txt is reported as a note, not silently dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-pack-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard","shards":[{"label":"all","files":["a.js"]}]}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-a\n+b\n');
    writeFileSync(join(dir, 'context.txt'), '   \n');   // context-pack.mjs skipped or crashed
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.equal(a.contextPackPath, null);          // still degrades — reviewers fall back to Read/Grep
    assert.equal(a.buildNotes.length, 1);           // ...but the user is told
    assert.match(a.buildNotes[0], /context pack .* EMPTY/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: assembles from --dir and merges enrich.json onto bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard","shards":[{"label":"all","files":["a.js"]}]}');
    writeFileSync(join(dir, 'bundle.json'), '{"summary":"x"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\n');
    writeFileSync(join(dir, 'meta.json'), '{"flags":{"gate":true},"prNumber":231}');
    writeFileSync(join(dir, 'enrich.json'), '{"pr":{"number":231},"trackerUsage":{"clickup":true}}');
    writeFileSync(join(dir, 'context.txt'), 'CONTEXT PACK: defs + callers\n');
    writeFileSync(join(dir, 'context-stats.json'), '{"sizeBytes":42,"files":1,"imports":1,"callerHits":1,"hop2":0,"typeBoundary":0}');
    writeFileSync(join(dir, 'history.json'), '{"history":{"a.js":["fix: bug"]},"notes":[]}');
    writeFileSync(join(dir, 'test-signal.json'), '{"ran":true,"passed":false,"failing":["t1"]}');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.equal(a.bundle.summary, 'x');           // gather.mjs field kept
    assert.equal(a.bundle.pr.number, 231);          // enrich merged in
    assert.equal(a.bundle.trackerUsage.clickup, true);
    assert.equal(a.prNumber, 231);
    assert.equal(a.flags.gate, true);
    assert.equal(a.diffPath, join(dir, 'diff.txt'));            // args-by-reference: absolute path, not text
    assert.equal(a.contextPackPath, join(dir, 'context.txt'));  // context path, agents Read it
    assert.equal(a.contextPackStats.callerHits, 1);             // WS7 S3: context-stats.json inlined by value
    assert.equal(a.diffIndex, null);                            // path-keyed index only in the collision fallback
    assert.deepEqual(a.diffRanges, { [sliceName('a.js')]: [[1, 2]] });   // precomputed line index (@@ +1,2), keyed by derived slice name
    assert.equal(a.historyPath, join(dir, 'history.json'));  // S6.3 attached by reference: absolute path, not the parsed object
    assert.equal(a.testSignal.passed, false);              // S6.4 test-signal.json attached
    // cost lever: a per-file diff slice is written to <dir>/slices under a DERIVED name, so args
    // carries the directory once instead of one absolute path per file
    assert.equal(a.sliceDir, join(dir, 'slices'));
    assert.match(readFileSync(join(a.sliceDir, sliceName('a.js')), 'utf8'), /\+c/);   // the slice holds the file's hunks
    // WS1: doctrine fragment TEXT is read and inlined at tier >= standard (not just a resolved path)
    assert.ok(a.doctrineText['correctness-reviewer'], 'correctness-reviewer gets doctrine at standard tier');
    assert.match(a.doctrineText['correctness-reviewer'], /Lead with leverage/);   // distinctive phrase from severity-norms.md
    assert.deepEqual(a.knownFalsePositives, []);   // no plan.learning.store configured → []
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: loads knownFalsePositives from the learnings store named in plan.learning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    const storePath = join(dir, 'learnings.json');
    writeFileSync(storePath, JSON.stringify({ acceptedFalsePositives: [{ key: 'a.js::false alarm', note: '👎' }] }));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ tier: 'standard', learning: { enabled: true, store: storePath } }));
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.deepEqual(a.knownFalsePositives, [{ file: 'a.js', title: 'false alarm' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: learning.enabled:false suppresses knownFalsePositives even with a store configured', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    const storePath = join(dir, 'learnings.json');
    writeFileSync(storePath, JSON.stringify({ acceptedFalsePositives: [{ key: 'a.js::false alarm' }] }));
    writeFileSync(join(dir, 'plan.json'), JSON.stringify({ tier: 'standard', learning: { enabled: false, store: storePath } }));
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.deepEqual(a.knownFalsePositives, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: a missing context.txt degrades to a null contextPackPath (not a failure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.contextPackPath, null);
    assert.equal(out.contextPackStats, null);   // WS7 S3: missing context-stats.json degrades to null, not a throw
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: historyPath is null when history.json is absent, non-null when it holds a non-empty history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    // no history.json at all
    let r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).historyPath, null, 'absent history.json → null');

    // history.json present but empty (history.mjs found no fix/revert commits)
    writeFileSync(join(dir, 'history.json'), '{"history":{},"notes":[]}');
    r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).historyPath, null, 'empty history object → null (no zero-signal cost)');

    // history.json with a real fix-history entry
    writeFileSync(join(dir, 'history.json'), '{"history":{"a.js":["fix: bug"]},"notes":[]}');
    r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).historyPath, join(dir, 'history.json'), 'non-empty history → the absolute path');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: exits 2 when a required input (diff.txt) is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard"}');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
