import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload, pluginAgent, PLUGIN_NS } from '../lib/review-orchestration.mjs';

test('expandAspects = dimensions × shards', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ label: 'A', files: ['a.ts'] }, { label: 'B', files: ['b.ts'] }],
  );
  assert.equal(aspects.length, 4);
  assert.deepEqual(aspects[0], { dim: 'D2', agent: 'correctness-reviewer', shardId: 'A', files: ['a.ts'] });
});

test('expandAspects collapses unsharded dims to one all-files aspect', () => {
  const shards = [{ label: 'A', files: ['a.ts'] }, { label: 'B', files: ['b.ts'] }];
  const aspects = expandAspects({ D2: 'correctness-reviewer', D3: 'vuln-reviewer' }, shards, { unsharded: ['D3'] });
  // D2 stays sharded (×2); D3 collapses to a single aspect over the union of all files
  assert.equal(aspects.length, 3);
  const d3 = aspects.filter((a) => a.dim === 'D3');
  assert.equal(d3.length, 1);
  assert.deepEqual(d3[0], { dim: 'D3', agent: 'vuln-reviewer', shardId: 'all', files: ['a.ts', 'b.ts'] });
  assert.equal(aspects.filter((a) => a.dim === 'D2').length, 2);
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
test('review-workflow.mjs declares a valid meta with 4 phases', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const meta = \{/);
  for (const p of ['Intent', 'Review', 'Verify', 'Synthesize']) {
    assert.ok(src.includes(`title: '${p}'`), `meta must list phase ${p}`);
  }
  // the report is rendered by the COMMAND (node report.mjs), not a workflow phase/agent
  assert.ok(!src.includes("title: 'Report'"), 'Report phase must be gone — report.mjs is run by the command');
  assert.doesNotMatch(src, /label: 'report'/, 'report executor agent must be removed — the workflow returns the payload');
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
  // triage-classifier is skipped for the trivial tier only (rank 5)
  assert.match(src, /plan\.tier !== 'trivial'/, 'triage-classifier must be guarded for the trivial tier');
  // completeness-critic gates on the exhaustive discovery flag
  assert.match(src, /plan\.discovery\?\.completenessCritic/);
  // resolve is inlined (pure), not dispatched as a general-purpose executor agent
  assert.doesNotMatch(src, /label: 'resolve'/, 'resolve must be inlined, not dispatched');
  assert.match(src, /function resolveVerification\(/, 'resolveVerification must be inlined');
  assert.match(src, /function partition\(/, 'partition must be inlined');
  // verification is bounded by selectForVerification (verify the unsure, not every finding)
  assert.match(src, /selectForVerification\(rev\.findings/, 'verify must gate through selectForVerification');
  // plan.verify is consumed AS RESOLVED (camelCase, from plan.mjs) — merged over defaults, not
  // re-resolved through cleanVerify (which maps only snake_case and would revert custom config).
  assert.match(src, /\{ \.\.\.DEFAULT_VERIFY, \.\.\.\(plan\.verify \?\? \{\}\) \}/, 'policy must merge the resolved plan.verify');
  assert.doesNotMatch(src, /function cleanVerify\(/, 'cleanVerify must NOT be re-inlined — config is resolved once in plan.mjs');
  // cheap→strong verifier escalation helpers are inlined (canonical: lib/verify.mjs)
  assert.match(src, /function firstPassModel\(/, 'firstPassModel must be inlined (canonical: lib/verify.mjs)');
  assert.match(src, /function shouldEscalate\(/, 'shouldEscalate must be inlined (canonical: lib/verify.mjs)');
  // diff-trim (rank 1) is inlined + canonical in lib/trim-diff.mjs; D3 (security) stays on the full diff
  assert.match(src, /function filterDiff\(/, 'filterDiff must be inlined (canonical: lib/trim-diff.mjs)');
  assert.match(src, /diffForAspect/, 'dimension reviewers must use the shard-scoped diffForAspect');
  assert.match(src, /a\.dim !== 'D3'/, 'D3 (security) must never get a trimmed diff');
  // the dead pr-comment-author dispatch is gone (comments.mjs does the real posting)
  assert.doesNotMatch(src, /pluginAgent\('pr-comment-author'\)/, 'pr-comment-author dispatch must be removed');
});

test('inlined filterDiff stays in sync with the canonical lib/trim-diff.mjs', async () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  const { filterDiff } = await import('../lib/trim-diff.mjs');
  const diff = `diff --git a/x.mjs b/x.mjs\n--- a/x.mjs\n+++ b/x.mjs\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.mjs b/y.mjs\n--- a/y.mjs\n+++ b/y.mjs\n@@ -1 +1 @@\n-c\n+d\n`;
  // canonical behavior the inlined copy must reproduce: scope to one file, fall back on miss
  assert.match(filterDiff(diff, ['x.mjs']), /x\.mjs/);
  assert.doesNotMatch(filterDiff(diff, ['x.mjs']), /y\.mjs/);
  assert.equal(filterDiff(diff, ['nope.mjs']), diff);
  // the inlined copy must define the same gate + helpers (kept in sync by hand)
  assert.match(src, /function sectionPath\(/);
  assert.match(src, /const normPath =/);
});

test('buildReportPayload assembles all fields', () => {
  const p = buildReportPayload({
    plan: { tier: 'high', gate: { block_on: ['critical'] }, learning: { store: 's' }, range: 'a..b' },
    agentRuns: { 'vuln-reviewer': 2 },
    findings: [{ severity: 'minor', file: 'a', title: 't' }],
    criteria: [{ id: 'AC1', text: 'r', covered: true }],
    strengths: ['s'], summary: 'sum', needsHuman: ['q'], skipped: ['x'],
    context: { pr: null }, verifySummary: { kept: 1 },
    startedAt: '2026-06-22T00:00:00Z', prNumber: 7, checkout: null, commentMode: true,
  });
  assert.equal(p.tier, 'high');
  assert.equal(p.plan.tier, 'high');
  assert.equal(p.agentRuns['vuln-reviewer'], 2);
  assert.equal(p.gate.block_on[0], 'critical');
  assert.equal(p.commentMode, true);
  assert.equal(p.learningStore, 's');
  assert.equal(p.range, 'a..b');
});
