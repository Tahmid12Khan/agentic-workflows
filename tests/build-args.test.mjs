// Unit + CLI smoke tests for build-args.mjs — the args assembler that keeps the bulky
// diff/plan/bundle out of the main agent's context. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
    bundle: { summary: 's' }, diff: 'diff text',
    scrutiny: { foo: 1 }, checks: { bar: 2 },
    meta: { flags: { gate: true }, startedAt: 'T', prNumber: 7, checkout: null },
  });
  assert.deepEqual(Object.keys(out).sort(),
    ['bundle', 'checkout', 'diff', 'flags', 'plan', 'prNumber', 'routing', 'shards', 'startedAt'].sort());
  assert.deepEqual(out.shards, [{ label: 'all', files: ['a.js'] }]); // lifted from plan
  assert.deepEqual(out.routing, { scrutiny: { foo: 1 }, checks: { bar: 2 } });
  assert.equal(out.prNumber, 7);
});

test('buildArgs: missing meta/routing degrade to safe defaults, not throws', () => {
  const out = buildArgs({ plan: {}, bundle: {}, diff: 'd' });
  assert.deepEqual(out.shards, []);
  assert.deepEqual(out.routing, { scrutiny: null, checks: null });
  assert.deepEqual(out.flags, {});
  assert.equal(out.startedAt, null);
});

test('CLI: assembles from --dir and merges enrich.json onto bundle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-args-'));
  try {
    writeFileSync(join(dir, 'plan.json'), '{"tier":"standard","shards":[{"label":"all","files":["a.js"]}]}');
    writeFileSync(join(dir, 'bundle.json'), '{"summary":"x"}');
    writeFileSync(join(dir, 'diff.txt'), 'diff --git a/a.js b/a.js\n');
    writeFileSync(join(dir, 'meta.json'), '{"flags":{"gate":true},"prNumber":231}');
    writeFileSync(join(dir, 'enrich.json'), '{"pr":{"number":231},"trackerUsage":{"clickup":true}}');
    const r = spawnSync(process.execPath, [SCRIPT, '--dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const a = JSON.parse(r.stdout);
    assert.equal(a.bundle.summary, 'x');           // gather.mjs field kept
    assert.equal(a.bundle.pr.number, 231);          // enrich merged in
    assert.equal(a.bundle.trackerUsage.clickup, true);
    assert.equal(a.prNumber, 231);
    assert.equal(a.flags.gate, true);
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
