import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, renderVerdict, renderHtml, agentCoverage } from '../lib/render.mjs';

const findings = [
  { dimension: 'D3', severity: 'critical', file: 'src/auth.ts', line: 42, title: 'Missing authz', confidence: 95, evidence: 'no role check', fix: 'add requirePermission' },
  { dimension: 'D2', severity: 'minor', file: 'src/util.ts', line: 7, title: 'Magic number', confidence: 82, evidence: '', fix: 'name the constant' },
];
const criteria = [{ id: 'AC1', text: 'only admins can delete', covered: true, evidence: 'auth.test.ts:10' }];

test('verdict blocks on critical', () => {
  const v = renderVerdict(findings, { block_on: ['critical'], warn_on: ['high'] });
  assert.equal(v.verdict, 'BLOCK');
  assert.equal(v.exitCode, 1);
});

test('report groups by severity and includes traceability matrix', () => {
  const md = renderReport({ findings, criteria, tier: 'critical' });
  assert.match(md, /## Critical/);
  assert.match(md, /Missing authz/);
  assert.match(md, /AC1/);
  assert.match(md, /only admins can delete/);
});

test('only confidence>=80 findings are rendered', () => {
  const noisy = [...findings, { dimension: 'D2', severity: 'minor', file: 'x', line: 1, title: 'low conf', confidence: 50 }];
  const md = renderReport({ findings: noisy, criteria, tier: 'standard' });
  assert.doesNotMatch(md, /low conf/);
});

test('traceability leads with the requirement name, keeps the AC id as a tag', () => {
  const md = renderReport({ findings, criteria, tier: 'standard' });
  // the requirement text comes before its `AC1` id on the line
  assert.match(md, /\*\*only admins can delete\*\* `AC1`/);
});

const standardPlan = {
  tier: 'standard',
  dimensions: ['D1', 'D2', 'D4', 'D5', 'D12', 'D16'],
  dimensionLabels: { D1: 'intent', D2: 'correctness', D4: 'error handling', D5: 'tests', D12: 'project-rules', D16: 'simplification' },
  models: { D1: 'sonnet', D2: 'sonnet', D4: 'sonnet', D5: 'sonnet', D12: 'sonnet', D16: 'sonnet' },
  runVerify: false,
  discovery: { taint: false, completenessCritic: false },
  sharded: false,
  shards: [],
};

test('agentCoverage classifies ran vs not-run from the plan, total is the full roster', () => {
  const cov = agentCoverage(standardPlan);
  assert.equal(cov.total, 23); // 14 dimension reviewers + 9 pipeline agents
  const ran = new Set(cov.ran.map((a) => a.name));
  const notRun = new Set(cov.notRun.map((a) => a.name));
  // standard tier: correctness + the gated specialists ran
  assert.ok(ran.has('correctness-reviewer'));
  assert.ok(ran.has('business-logic-analyzer')); // runs at standard+
  // security/concurrency not triggered → not run
  assert.ok(notRun.has('vuln-reviewer'));
  assert.ok(notRun.has('concurrency-reviewer'));
  // verify only at high/critical
  assert.ok(notRun.has('finding-verifier'));
  // no --comment
  assert.ok(notRun.has('pr-comment-author'));
  // a not-run reason explains WHY
  const vuln = cov.notRun.find((a) => a.name === 'vuln-reviewer');
  assert.match(vuln.reason, /security/);
});

test('agentCoverage uses observed run counts when provided, else the planned count', () => {
  const cov = agentCoverage(standardPlan, { 'correctness-reviewer': 5 });
  const corr = cov.ran.find((a) => a.name === 'correctness-reviewer');
  assert.equal(corr.runs, 5); // observed override wins
  assert.ok(cov.dispatches >= 5);
});

test('agentCoverage flags a trivial change as inline (no subagents)', () => {
  const cov = agentCoverage({ tier: 'trivial', dimensions: ['D2', 'D13'], runVerify: false });
  assert.equal(cov.trivialInline, true);
  const notRun = new Set(cov.notRun.map((a) => a.name));
  assert.ok(notRun.has('review-synthesizer')); // skipped — reviewed inline
});

test('reports render an Agents & coverage section in markdown and HTML', () => {
  const coverage = agentCoverage(standardPlan);
  const md = renderReport({ findings, criteria, tier: 'standard', coverage });
  assert.match(md, /## Agents & coverage/);
  assert.match(md, /of 23 bundled agents ran/);
  assert.match(md, /vuln-reviewer/);
  const html = renderHtml({ findings, criteria, tier: 'standard', coverage });
  assert.match(html, /Agents &amp; coverage/);
  assert.match(html, /finding-verifier/);
});

test('reports show PR number and start/finish timestamps from meta', () => {
  const meta = { prNumber: 42, started: 'Sun, 21 Jun 2026 14:00:00 GMT', finished: 'Sun, 21 Jun 2026 14:02:01 GMT', duration: '2m 1s' };
  const md = renderReport({ findings, criteria, tier: 'standard', meta });
  assert.match(md, /PR #42/);
  assert.match(md, /started Sun, 21 Jun 2026 14:00:00 GMT/);
  assert.match(md, /took 2m 1s/);
  const html = renderHtml({ findings, criteria, tier: 'standard', meta });
  assert.match(html, /PR #42/);
  assert.match(html, /14:02:01 GMT/);
});

test('needs-input items render even as bare strings or sparse objects (no empty cards)', () => {
  const nh = ['Should deleting a user cascade to their orders?', { verify: { passes: 3, real: 1, refuted: 1 } }];
  const md = renderReport({ findings, criteria, tier: 'high', needsHuman: nh });
  assert.match(md, /Should deleting a user cascade/);   // string item is shown
  assert.match(md, /\(unspecified/);                     // sparse object gets a visible placeholder
  const html = renderHtml({ findings, criteria, tier: 'high', needsHuman: nh });
  assert.match(html, /Should deleting a user cascade/);
  assert.match(html, /Needs your input/);
  assert.doesNotMatch(html, /f-loc">\?/);                // no bare "?" location
});
