// Unit + CLI smoke tests for build-args.mjs — the args assembler that keeps the bulky
// diff/plan/bundle out of the main agent's context. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, mergeEnrich, knownFalsePositives, restrictIndexToFiles } from '../lib/build-args.mjs';

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
    ['bundle', 'checkout', 'contextPackPath', 'contextPackStats', 'diffIndex', 'diffPath', 'doctrinePaths', 'flags', 'history', 'knownFalsePositives', 'plan', 'prNumber', 'routing', 'shards', 'sliceIndex', 'startedAt', 'testSignal'].sort());
  assert.deepEqual(out.sliceIndex, {});   // absent → {} so the workflow falls back to the full diff (no slicing)
  assert.deepEqual(out.doctrinePaths, {});   // WS1: absent → {} so the workflow attaches no doctrine
  assert.deepEqual(out.shards, [{ label: 'all', files: ['a.js'] }]); // lifted from plan
  assert.deepEqual(out.routing, { scrutiny: { foo: 1 }, checks: { bar: 2 } });
  assert.equal(out.prNumber, 7);
  assert.equal(out.diffPath, '/scratch/diff.txt');   // args-by-reference: path, not text
  assert.deepEqual(out.diffIndex, { 'a.js': [[1, 3]] });
  assert.equal(out.contextPackPath, null);   // absent → null so the workflow prepends nothing
  assert.equal(out.contextPackStats, null);  // WS7 S3 absent → null so the coverage section omits the line
  assert.deepEqual(out.history, {});   // S6.3 absent → {} so the workflow attaches nothing
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

test('buildArgs: S6 history + testSignal are carried through when provided', () => {
  const history = { 'src/a.js': ['fix: bug'] };
  const testSignal = { ran: true, passed: false, failing: ['t1'] };
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d', history, testSignal });
  assert.deepEqual(out.history, history);
  assert.deepEqual(out.testSignal, testSignal);
});

test('buildArgs: missing meta/routing degrade to safe defaults, not throws', () => {
  const out = buildArgs({ plan: {}, bundle: {}, diffPath: '/d' });
  assert.deepEqual(out.shards, []);
  assert.deepEqual(out.routing, { scrutiny: null, checks: null });
  assert.deepEqual(out.flags, {});
  assert.equal(out.startedAt, null);
  assert.equal(out.contextPackPath, null);
  assert.deepEqual(out.diffIndex, {});   // absent → {} so the workflow demotes nothing (no crash)
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

test('restrictIndexToFiles: keeps only reviewed-file entries (normPath both sides), drops the rest', () => {
  const idx = { 'src/a.js': [[1, 3]], 'src/b.js': [[4, 5]], 'src/c.js': [[6, 7]] };
  const kept = restrictIndexToFiles(idx, ['src/a.js', 'src/c.js']);
  assert.deepEqual(Object.keys(kept).sort(), ['src/a.js', 'src/c.js']);
  // tolerates a/ b/ prefixes on either side via normPath, and empty/absent inputs
  assert.deepEqual(restrictIndexToFiles({ 'b/src/a.js': 1 }, ['src/a.js']), { 'b/src/a.js': 1 });
  assert.deepEqual(restrictIndexToFiles({}, ['src/a.js']), {});
  assert.deepEqual(restrictIndexToFiles({ 'x.js': 1 }, []), {});
});

test('CLI: when plan.filesCapped is set, sliceIndex + diffIndex are restricted to the reviewed files', () => {
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
    assert.deepEqual(Object.keys(a.diffIndex), ['a.js'], 'diffIndex drops the unreviewed b.js');
    assert.deepEqual(Object.keys(a.sliceIndex), ['a.js'], 'sliceIndex drops the unreviewed b.js');
    assert.deepEqual(a.plan.filesCapped, { max: 1, total: 2, reviewed: 1, dropped: 1 }); // carried through
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
    assert.deepEqual(a.diffIndex, { 'a.js': [[1, 2]] });        // precomputed line index (@@ +1,2)
    assert.deepEqual(a.history, { 'a.js': ['fix: bug'] });  // S6.3 unwrapped from history.json
    assert.equal(a.testSignal.passed, false);              // S6.4 test-signal.json attached
    // cost lever: a per-file diff slice is written to <dir>/slices and mapped by normalized path
    assert.ok(a.sliceIndex['a.js'], 'a slice path is written for the changed file');
    assert.match(a.sliceIndex['a.js'], /\/slices\/\d+\.patch$/);
    assert.match(readFileSync(a.sliceIndex['a.js'], 'utf8'), /\+c/);   // the slice holds the file's hunks
    // WS1: doctrine paths are resolved to absolute paths under agents/doctrine/ at tier >= standard
    assert.ok(a.doctrinePaths['correctness-reviewer'], 'correctness-reviewer gets doctrine at standard tier');
    assert.match(a.doctrinePaths['correctness-reviewer'][0], /\/agents\/doctrine\/[a-z-]+\.md$/);
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

test('CLI: exits 2 when a required input (diff.txt) is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard"}');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /missing required/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
