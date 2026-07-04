import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, renderVerdict, renderHtml, agentCoverage, testSignalText } from '../lib/render.mjs';

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

// --- S6.4: executed-test signal in the report header ---
test('testSignalText: null when not run, pass/fail line with capped names otherwise', () => {
  assert.equal(testSignalText(null), null);
  assert.equal(testSignalText({ ran: false }), null);
  assert.equal(testSignalText({ ran: true, passed: true }), 'Tests: passed');
  assert.equal(testSignalText({ ran: true, passed: false, failing: ['a', 'b'] }), 'Tests: FAILED — a, b');
  const many = Array.from({ length: 10 }, (_, i) => `t${i}`);
  assert.equal(testSignalText({ ran: true, passed: false, failing: many }, 2), 'Tests: FAILED — t0, t1, +8 more');
});

test('the test signal appears in the md + html header only when tests ran', () => {
  const failed = { ran: true, passed: false, failing: ['auth spec'] };
  assert.match(renderReport({ findings, criteria, tier: 'high', testSignal: failed }), /Tests: FAILED — auth spec/);
  assert.match(renderHtml({ findings, criteria, tier: 'high', testSignal: failed }), /Tests: FAILED/);
  // not run → no line at all
  assert.doesNotMatch(renderReport({ findings, criteria, tier: 'high' }), /Tests:/);
  assert.doesNotMatch(renderHtml({ findings, criteria, tier: 'high' }), /Tests:/);
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
  assert.equal(cov.total, 20); // 14 dimension reviewers + 6 pipeline agents
  const ran = new Set(cov.ran.map((a) => a.name));
  const notRun = new Set(cov.notRun.map((a) => a.name));
  // standard tier: correctness + the gated specialists ran
  assert.ok(ran.has('correctness-reviewer'));
  assert.ok(ran.has('intent-analyzer')); // merged intent agent runs at low+
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
  // intent-analyzer is planned at standard tier but absent from the observed map → did NOT run
  assert.ok(cov.notRun.some((a) => a.name === 'intent-analyzer'));
  assert.ok(!cov.ran.some((a) => a.name === 'intent-analyzer'));
});

test('a planned agent that dispatched 0 times is NOT listed as "ran 0×"', () => {
  // regression: the RAN section used the planned `ran` flag while the ×N count used the
  // observed map, so a planned-but-zero-dispatch agent appeared under RAN showing 0×.
  const cov = agentCoverage(standardPlan, { 'correctness-reviewer': 1, 'intent-analyzer': 0 });
  // no row in the RAN section may show a zero count
  assert.ok(cov.ran.every((a) => a.runs > 0), 'every RAN agent must have a positive dispatch count');
  // the zero-dispatch agent is moved to notRun with an honest reason
  const ih = cov.notRun.find((a) => a.name === 'intent-analyzer');
  assert.ok(ih, 'intent-analyzer (observed 0) belongs under did-not-run');
  assert.match(ih.reason, /no dispatch/);
});

test('merged intent-analyzer runs at LOW tier (S3: low+, not standard+)', () => {
  // regression for the merge: the former business-logic-analyzer was skipped at low; the merged
  // intent-analyzer must run at low+ so low-tier reviewers still get an intent brief.
  const lowPlan = { ...standardPlan, tier: 'low' };
  const cov = agentCoverage(lowPlan); // planned expectation (no observed counts)
  assert.ok(cov.ran.some((a) => a.name === 'intent-analyzer'), 'intent-analyzer must run at low tier');
});

test('with no observed counts (trivial inline path), the planned expectation is used', () => {
  const cov = agentCoverage(standardPlan); // empty map → fall back to plan
  assert.ok(cov.ran.some((a) => a.name === 'correctness-reviewer'));
  assert.ok(cov.ran.some((a) => a.name === 'intent-analyzer'));
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
  assert.match(md, /of 20 bundled agents ran/);
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

test('usage panel renders in the info row below the header, omitted otherwise', () => {
  const usage = { inputTokens: 23895, outputTokens: 739, cacheReadTokens: 20975, cacheWriteTokens: 6148, costUsd: 0.1234, messages: 5 };
  const html = renderHtml({ findings, criteria, tier: 'standard', usage });
  assert.match(html, /class="usage"/);
  assert.match(html, /23,895/);          // thousands-separated token count
  assert.match(html, /cache read/);
  assert.match(html, /\$0\.1234/);       // sub-$1 cost shown to 4 dp
  // panel now sits in the info row, below the header + meta line (not floated top-left)
  assert.match(html, /class="info-row"/);
  assert.ok(html.indexOf('class="usage"') > html.indexOf('class="top"'));
  // no usage → no panel, report unchanged
  assert.doesNotMatch(renderHtml({ findings, criteria, tier: 'standard' }), /class="usage"/);
});

test('usage panel + markdown Cost show cache-hit% and the per-scope/model breakdown', () => {
  const usage = {
    inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000, cacheWriteTokens: 50, costUsd: 0.5, messages: 4,
    cacheHitPct: 0.75,
    breakdown: [
      { scope: 'subagents', model: 'sonnet', costUsd: 0.4, cacheHitPct: 0.8 },
      { scope: 'orchestrator', model: 'opus', costUsd: 0.1, cacheHitPct: 0.6 },
    ],
  };
  const html = renderHtml({ findings, criteria, tier: 'standard', usage });
  assert.match(html, /cache hit/);
  assert.match(html, /75%/);
  assert.match(html, /subagents · sonnet/);   // per-scope/model cost row in the panel
  // markdown now carries a Cost section (previously HTML-only)
  const md = renderReport({ findings, criteria, tier: 'standard', usage });
  assert.match(md, /## Cost/);
  assert.match(md, /cache hit 75%/);
  assert.match(md, /\*\*subagents · sonnet\*\*/);
  // no usage → no Cost section, markdown unchanged
  assert.doesNotMatch(renderReport({ findings, criteria, tier: 'standard' }), /## Cost/);
});

test('PR-info panel shows base/target branch, sha, date, subject; md mirrors it', () => {
  const checkout = {
    baseRef: 'origin/main', headRef: 'origin/feature', sha: 'abc12345def67890',
    baseCommit: { branch: 'main', ref: 'origin/main', sha: 'ba5e0000cafef00d', subject: 'fix: base thing', date: '2026-07-01', origin: null },
    headCommit: { branch: 'feature/zip-tax', ref: 'origin/feature', sha: 'abc12345def67890', subject: 'feat: zip-code tax', date: '2026-07-02', origin: null },
  };
  const html = renderHtml({ findings, criteria, tier: 'standard', checkout });
  assert.match(html, /class="prinfo"/);
  assert.match(html, /feature\/zip-tax/);         // target branch
  assert.match(html, />base</);                   // base label
  assert.match(html, /abc12345/);                 // target short sha
  assert.match(html, /ba5e0000/);                 // base short sha
  assert.match(html, /2026-07-02/);               // target commit date
  assert.match(html, /feat: zip-code tax/);       // target subject
  // markdown records the same facts after the meta line
  const md = renderReport({ findings, criteria, tier: 'standard', checkout });
  assert.match(md, /\*\*base\*\* `main` `ba5e0000` \(2026-07-01\) — fix: base thing/);
  assert.match(md, /\*\*target\*\* `feature\/zip-tax` `abc12345` \(2026-07-02\) — feat: zip-code tax/);
});

test('PR-info shows an origin line only when the reviewed ref diverged from origin', () => {
  const diverged = {
    baseCommit: { branch: 'main', ref: 'main', sha: 'aaaa1111bbbb', subject: 'local base', date: '2026-06-30',
      origin: { sha: 'ffff9999eeee', subject: 'newer on origin', date: '2026-07-02' } },
    headCommit: { branch: 'feature', ref: 'origin/feature', sha: 'cccc2222dddd', subject: 'the change', date: '2026-07-03', origin: null },
  };
  const html = renderHtml({ findings, criteria, tier: 'standard', checkout: diverged });
  assert.match(html, /class="pr-origin"/);
  assert.match(html, /origin ffff9999/);
  // the matched (target) side has no origin line — in general they are the same
  assert.equal((html.match(/class="pr-origin"/g) || []).length, 1);
  assert.match(renderReport({ findings, criteria, tier: 'standard', checkout: diverged }), /origin `ffff9999`/);
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

test('out-of-diff findings render in their own section (md + html), separate from gated findings', () => {
  const outOfDiff = [{ file: 'src/x.js', line: 99, title: 'adjacent smell', dimension: 'D2', severity: 'minor', evidence: 'e', fix: 'f' }];
  const md = renderReport({ findings: [], criteria, tier: 'standard', outOfDiff });
  assert.match(md, /## Out-of-scope observations/);
  assert.match(md, /adjacent smell/);
  assert.match(md, /excluded from the verdict/i);
  const html = renderHtml({ findings: [], criteria, tier: 'standard', outOfDiff });
  assert.match(html, /Out-of-scope observations/);
  assert.match(html, /adjacent smell/);
});

test('verdict floor: high/critical tier with zero findings → non-blocking WARN, not APPROVE', () => {
  const gate = { block_on: ['critical'], warn_on: ['high'] };
  assert.equal(renderVerdict([], gate, 'high').verdict, 'WARN');
  assert.equal(renderVerdict([], gate, 'critical').verdict, 'WARN');
  assert.equal(renderVerdict([], gate, 'high').exitCode, 0);          // floor never blocks
  assert.equal(renderVerdict([], gate, 'standard').verdict, 'APPROVE'); // floor is high/critical only
  // a real finding still resolves normally (floor only fires on zero)
  assert.equal(renderVerdict([{ severity: 'critical', confidence: 100 }], gate, 'high').verdict, 'BLOCK');
  // md surfaces the floor note
  const md = renderReport({ findings: [], criteria, tier: 'high' });
  assert.match(md, /WARN, not a clean pass/);
  assert.match(md, /## Verdict: WARN/);
});

test('out-of-diff findings never affect the verdict (excluded from the gate)', () => {
  // a critical, out-of-diff finding rides in outOfDiff — the gated `findings` list is empty → APPROVE
  const md = renderReport({ findings: [], criteria, tier: 'standard', outOfDiff: [{ file: 'x', line: 1, title: 'crit', severity: 'critical', confidence: 100 }] });
  assert.match(md, /## Verdict: APPROVE/);
});
