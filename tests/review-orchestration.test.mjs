import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload } from '../lib/review-orchestration.mjs';

test('expandAspects = dimensions × shards', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ id: 'A', files: ['a.ts'] }, { id: 'B', files: ['b.ts'] }],
  );
  assert.equal(aspects.length, 4);
  assert.deepEqual(aspects[0], { dim: 'D2', agent: 'correctness-reviewer', shardId: 'A', files: ['a.ts'] });
});

test('findingKey is line-sensitive and title-normalized', () => {
  assert.equal(findingKey({ file: 'x.ts', line: 10, title: '  SQL Injection ' }), 'x.ts:10:sql injection');
  assert.notEqual(
    findingKey({ file: 'x.ts', line: 10, title: 'bug' }),
    findingKey({ file: 'x.ts', line: 11, title: 'bug' }),
  );
});

test('cap counters stop at max', () => {
  const caps = newCaps();
  assert.equal(canSpawn(caps, 'verify:x:1', 3), true);
  recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1');
  assert.equal(canSpawn(caps, 'verify:x:1', 3), false);
  assert.equal(canSpawn(caps, 'verify:x:2', 3), true);
});

test('buildReportPayload throws without plan or agentRuns', () => {
  assert.throws(() => buildReportPayload({ agentRuns: {} }), /plan/);
  assert.throws(() => buildReportPayload({ plan: {} }), /agentRuns/);
});

test('buildReportPayload assembles all fields', () => {
  const p = buildReportPayload({
    plan: { tier: 'high', gate: { block_on: ['critical'] }, learning: { store: 's' }, range: 'a..b' },
    agentRuns: { 'vuln-reviewer': 2 },
    findings: [{ severity: 'minor', file: 'a', title: 't' }],
    criteria: [{ id: 'AC1', text: 'r', covered: true }],
    strengths: ['s'], summary: 'sum', needsHuman: ['q'], skipped: ['x'],
    context: { pr: null }, verifySummary: { kept: 1 },
    startedAt: '2026-06-22T00:00:00Z', prNumber: 7, worktrees: [], commentMode: true,
  });
  assert.equal(p.tier, 'high');
  assert.equal(p.plan.tier, 'high');
  assert.equal(p.agentRuns['vuln-reviewer'], 2);
  assert.equal(p.gate.block_on[0], 'critical');
  assert.equal(p.commentMode, true);
  assert.equal(p.learningStore, 's');
  assert.equal(p.range, 'a..b');
});
