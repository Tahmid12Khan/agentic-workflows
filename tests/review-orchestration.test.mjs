import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload, pluginAgent, PLUGIN_NS } from '../lib/review-orchestration.mjs';

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

test('pluginAgent namespaces bundled agents, passes built-ins through, is idempotent', () => {
  assert.equal(pluginAgent('error-handling-reviewer'), `${PLUGIN_NS}:error-handling-reviewer`);
  assert.equal(pluginAgent('finding-verifier'), `${PLUGIN_NS}:finding-verifier`);
  // built-in harness agent must NOT be namespaced — it has no plugin entry
  assert.equal(pluginAgent('general-purpose'), 'general-purpose');
  // already-namespaced and empty inputs pass through untouched
  assert.equal(pluginAgent(`${PLUGIN_NS}:vuln-reviewer`), `${PLUGIN_NS}:vuln-reviewer`);
  assert.equal(pluginAgent(''), '');
  assert.equal(pluginAgent(undefined), undefined);
});

import { readFileSync } from 'node:fs';
test('review-workflow.mjs declares a valid meta with 5 phases', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const meta = \{/);
  for (const p of ['Intent', 'Review', 'Verify', 'Synthesize', 'Report']) {
    assert.ok(src.includes(`title: '${p}'`), `meta must list phase ${p}`);
  }
  // inlined helpers must match the canonical signatures
  assert.match(src, /function expandAspects\(/);
  assert.match(src, /const findingKey =/);
  // every plugin agent dispatch must be namespaced; only built-ins stay bare
  assert.match(src, /const pluginAgent =/);
  assert.doesNotMatch(src, /agentType: '(?!general-purpose')[a-z-]+'/,
    'no bare plugin agentType literal may remain — wrap it in pluginAgent()');
  // triage-classifier and completeness-critic must be actually dispatched (not just listed in render.mjs)
  assert.match(src, /pluginAgent\('triage-classifier'\)/, 'triage-classifier must be dispatched');
  assert.match(src, /pluginAgent\('completeness-critic'\)/, 'completeness-critic must be dispatched');
  // completeness-critic gates on the exhaustive discovery flag
  assert.match(src, /plan\.discovery\?\.completenessCritic/);
  // resolve is inlined (pure), not dispatched as a general-purpose executor agent
  assert.doesNotMatch(src, /label: 'resolve'/, 'resolve must be inlined, not dispatched');
  assert.match(src, /function resolveVerification\(/, 'resolveVerification must be inlined');
  assert.match(src, /function partition\(/, 'partition must be inlined');
  // verification is bounded by selectForVerification (verify the unsure, not every finding)
  assert.match(src, /selectForVerification\(rev\.findings/, 'verify must gate through selectForVerification');
  // policy is wrapped so maxVerifierPasses is derived (raw plan.verify would break the cap)
  assert.match(src, /verifyPolicy\(\{ verify: plan\.verify \}\)/);
  // the report executor runs on haiku (it only shells out to report.mjs)
  assert.match(src, /label: 'report'[^}]*model: 'haiku'|model: 'haiku'[^}]*label: 'report'/, 'report executor must run on haiku');
  // the dead pr-comment-author dispatch is gone (comments.mjs does the real posting)
  assert.doesNotMatch(src, /pluginAgent\('pr-comment-author'\)/, 'pr-comment-author dispatch must be removed');
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
