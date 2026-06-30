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

test('summaryPoints render as bullets under the headline (md + html)', () => {
  const opts = { findings, criteria, tier: 'standard', summary: 'No blockers; merge after OTel sign-off.', summaryPoints: ['Java 25 bump applied consistently', 'OTel sampling reversed — needs owner sign-off'] };
  const md = renderReport(opts);
  assert.match(md, /No blockers; merge after OTel sign-off\./);
  assert.match(md, /- Java 25 bump applied consistently/);
  assert.match(md, /- OTel sampling reversed/);
  const html = renderHtml(opts);
  assert.match(html, /<ul class="sum">/);
  assert.match(html, /<li>Java 25 bump applied consistently<\/li>/);
});

test('a finding the verifier looked at shows "verified ×N"; a trusted one shows "trusted"', () => {
  const mixed = [
    { dimension: 'D3', severity: 'critical', file: 'a.ts', line: 1, title: 'really checked', confidence: 90, verify: { passes: 2, real: 1, refuted: 0 } },
    { dimension: 'D2', severity: 'minor', file: 'b.ts', line: 2, title: 'just trusted', confidence: 92 },
  ];
  const md = renderReport({ findings: mixed, criteria, tier: 'high' });
  assert.match(md, /really checked\*\* \(D3 · verified ×2\)/);
  assert.match(md, /just trusted\*\* \(D2 · trusted\)/);
  const html = renderHtml({ findings: mixed, criteria, tier: 'high' });
  assert.match(html, /verified ×2<\/b> \(1✓\/0✗\)/);
  assert.match(html, / · trusted · conf 92/);
});

test('passes===1 (no verifier look) is trusted, not "verified ×1"', () => {
  const trustedOnly = [{ dimension: 'D2', severity: 'minor', file: 'c.ts', line: 3, title: 'carried through', confidence: 88, verify: { passes: 1, real: 0, refuted: 0 } }];
  const md = renderReport({ findings: trustedOnly, criteria, tier: 'standard' });
  assert.match(md, /carried through\*\* \(D2 · trusted\)/);
  assert.doesNotMatch(md, /verified ×1/);
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
  assert.equal(cov.total, 21); // 14 dimension reviewers + 7 pipeline agents
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
  // a not-run reason explains WHY
  const vuln = cov.notRun.find((a) => a.name === 'vuln-reviewer');
  assert.match(vuln.reason, /security/);
});

test('observed dispatch counts are authoritative: RAN follows the count, not the planned flag', () => {
  // when a real counts map is present, it is COMPLETE — an agent absent from it ran 0 times
  const cov = agentCoverage(standardPlan, { 'correctness-reviewer': 5 });
  const corr = cov.ran.find((a) => a.name === 'correctness-reviewer');
  assert.equal(corr.runs, 5); // observed count wins
  assert.ok(cov.dispatches >= 5);
  // business-logic-analyzer is planned at standard tier but absent from the observed map → did NOT run
  assert.ok(cov.notRun.some((a) => a.name === 'business-logic-analyzer'));
  assert.ok(!cov.ran.some((a) => a.name === 'business-logic-analyzer'));
});

test('a planned agent that dispatched 0 times is NOT listed as "ran 0×"', () => {
  // regression: the RAN section used the planned `ran` flag while the ×N count used the
  // observed map, so a planned-but-zero-dispatch agent appeared under RAN showing 0×.
  const cov = agentCoverage(standardPlan, { 'correctness-reviewer': 1, 'intent-harvester': 0 });
  // no row in the RAN section may show a zero count
  assert.ok(cov.ran.every((a) => a.runs > 0), 'every RAN agent must have a positive dispatch count');
  // the zero-dispatch agent is moved to notRun with an honest reason
  const ih = cov.notRun.find((a) => a.name === 'intent-harvester');
  assert.ok(ih, 'intent-harvester (observed 0) belongs under did-not-run');
  assert.match(ih.reason, /no dispatch/);
});

test('with no observed counts (trivial inline path), the planned expectation is used', () => {
  const cov = agentCoverage(standardPlan); // empty map → fall back to plan
  assert.ok(cov.ran.some((a) => a.name === 'correctness-reviewer'));
  assert.ok(cov.ran.some((a) => a.name === 'business-logic-analyzer'));
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
  assert.match(md, /of 21 bundled agents ran/);
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

test('reports state whether each enabled tracker was used (off ones omitted)', () => {
  const context = {
    trackerUsage: {
      clickup: { status: 'used', detail: '2 ticket(s) via MCP' },
      jira: { status: 'skipped-no-mcp' },
    },
  };
  const md = renderReport({ findings, criteria, tier: 'standard', context });
  assert.match(md, /ClickUp: used \(2 ticket\(s\) via MCP\)/);
  assert.match(md, /Jira: skipped — MCP server not connected/);
  const html = renderHtml({ findings, criteria, tier: 'standard', context });
  assert.match(html, /ClickUp: used/);
  assert.match(html, /Jira: skipped/);
  // an 'off' tracker is not mentioned
  const off = renderReport({ findings, criteria, tier: 'standard', context: { trackerUsage: { clickup: { status: 'off' }, jira: { status: 'off' } } } });
  assert.doesNotMatch(off, /ClickUp|Jira/);
});

test('reports name the head/base the review was checked out against', () => {
  const checkout = { baseRef: 'origin/main', headRef: 'origin/feature', sha: 'abc12345def67890' };
  const md = renderReport({ findings, criteria, tier: 'standard', checkout });
  assert.match(md, /## Context used/);
  assert.match(md, /Reviewed origin\/feature vs origin\/main @ abc12345/);
  const html = renderHtml({ findings, criteria, tier: 'standard', checkout });
  assert.match(html, /Reviewed origin\/feature vs origin\/main @ abc12345/);
});

test('usage panel renders top-left when usage is present, omitted otherwise', () => {
  const usage = { inputTokens: 23895, outputTokens: 739, cacheReadTokens: 20975, cacheWriteTokens: 6148, costUsd: 0.1234, messages: 5 };
  const html = renderHtml({ findings, criteria, tier: 'standard', usage });
  assert.match(html, /class="usage"/);
  assert.match(html, /23,895/);          // thousands-separated token count
  assert.match(html, /cache read/);
  assert.match(html, /\$0\.1234/);       // sub-$1 cost shown to 4 dp
  // panel sits before the header row (top-left)
  assert.ok(html.indexOf('class="usage"') < html.indexOf('class="top"'));
  // no usage → no panel, report unchanged
  assert.doesNotMatch(renderHtml({ findings, criteria, tier: 'standard' }), /class="usage"/);
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
