// Unit + CLI smoke tests for build-args.mjs — the args assembler that keeps the bulky
// diff/plan/bundle out of the main agent's context. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, mergeEnrich } from '../lib/build-args.mjs';

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
    ['bundle', 'checkout', 'contextPackPath', 'diffIndex', 'diffPath', 'flags', 'history', 'plan', 'prNumber', 'routing', 'shards', 'sliceIndex', 'startedAt', 'testSignal'].sort());
  assert.deepEqual(out.sliceIndex, {});   // absent → {} so the workflow falls back to the full diff (no slicing)
  assert.deepEqual(out.shards, [{ label: 'all', files: ['a.js'] }]); // lifted from plan
  assert.deepEqual(out.routing, { scrutiny: { foo: 1 }, checks: { bar: 2 } });
  assert.equal(out.prNumber, 7);
  assert.equal(out.diffPath, '/scratch/diff.txt');   // args-by-reference: path, not text
  assert.deepEqual(out.diffIndex, { 'a.js': [[1, 3]] });
  assert.equal(out.contextPackPath, null);   // absent → null so the workflow prepends nothing
  assert.deepEqual(out.history, {});   // S6.3 absent → {} so the workflow attaches nothing
  assert.equal(out.testSignal, null);  // S6.4 absent → null (no --run-tests)
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

test('CLI: assembles from --dir and merges enrich.json onto bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard","shards":[{"label":"all","files":["a.js"]}]}');
    writeFileSync(join(dir, 'bundle.json'), '{"summary":"x"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1,2 @@\n-a\n+b\n+c\n');
    writeFileSync(join(dir, 'meta.json'), '{"flags":{"gate":true},"prNumber":231}');
    writeFileSync(join(dir, 'enrich.json'), '{"pr":{"number":231},"trackerUsage":{"clickup":true}}');
    writeFileSync(join(dir, 'context.txt'), 'CONTEXT PACK: defs + callers\n');
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
    assert.deepEqual(a.diffIndex, { 'a.js': [[1, 2]] });        // precomputed line index (@@ +1,2)
    assert.deepEqual(a.history, { 'a.js': ['fix: bug'] });  // S6.3 unwrapped from history.json
    assert.equal(a.testSignal.passed, false);              // S6.4 test-signal.json attached
    // cost lever: a per-file diff slice is written to <dir>/slices and mapped by normalized path
    assert.ok(a.sliceIndex['a.js'], 'a slice path is written for the changed file');
    assert.match(a.sliceIndex['a.js'], /\/slices\/\d+\.patch$/);
    assert.match(readFileSync(a.sliceIndex['a.js'], 'utf8'), /\+c/);   // the slice holds the file's hunks
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: a missing context.txt degrades to a null contextPackPath (not a failure)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).contextPackPath, null);
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
