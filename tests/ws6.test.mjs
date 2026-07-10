// WS6 unit tests: pre-existing bug partitioning (render.partitionOutOfDiff), the configurable
// gate.block_on (render.renderVerdict), and critical-always verification selection (verify.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partitionOutOfDiff, renderVerdict, renderReport } from '../lib/render.mjs';
import { selectForVerification, DEFAULT_VERIFY } from '../lib/verify.mjs';
import { generateReport } from '../lib/report.mjs';
import { loadLastReview } from '../lib/memory.mjs';

test('partitionOutOfDiff: bug-severity + verified-real → pre-existing; the rest → observations', () => {
  const oos = [
    { severity: 'critical', title: 'crit upheld', verify: { passes: 3, real: 2, refuted: 0 } },
    { severity: 'important', title: 'imp trusted' },                       // no verify → trusted, real
    { severity: 'minor', title: 'nit' },                                   // below bug severity
    { severity: 'suggestion', title: 'style' },
    { severity: 'critical', title: 'crit refuted', verify: { passes: 3, real: 0, refuted: 2 } }, // not upheld
  ];
  const { preExisting, observations } = partitionOutOfDiff(oos);
  assert.deepEqual(preExisting.map(f => f.title), ['crit upheld', 'imp trusted']);
  assert.deepEqual(observations.map(f => f.title).sort(), ['crit refuted', 'nit', 'style']);
});

test('partitionOutOfDiff: empty input → empty partitions', () => {
  assert.deepEqual(partitionOutOfDiff([]), { preExisting: [], observations: [] });
  assert.deepEqual(partitionOutOfDiff(), { preExisting: [], observations: [] });
});

test('gate.block_on is configurable: important blocks only when listed', () => {
  const important = [{ severity: 'important', confidence: 100 }];
  assert.equal(renderVerdict(important, { block_on: ['critical'], warn_on: ['high'] }).verdict, 'APPROVE');
  assert.equal(renderVerdict(important, { block_on: ['critical', 'important'], warn_on: [] }).verdict, 'BLOCK');
  // critical still blocks under the default
  assert.equal(renderVerdict([{ severity: 'critical', confidence: 100 }], { block_on: ['critical'] }).verdict, 'BLOCK');
});

test('renderReport verdict honors the passed gate (not hardcoded critical-only)', () => {
  const findings = [{ dimension: 'D2', severity: 'important', file: 'a.ts', line: 1, title: 'bug', confidence: 95 }];
  const md = renderReport({ findings, criteria: [], tier: 'standard', gate: { block_on: ['critical', 'important'], warn_on: [] } });
  assert.match(md, /## Verdict: BLOCK/);
  const mdDefault = renderReport({ findings, criteria: [], tier: 'standard' });   // default gate = critical-only
  assert.match(mdDefault, /## Verdict: WARN|## Verdict: APPROVE/);   // important does not block by default
});

test('selectForVerification: a critical is ALWAYS selected, even high-confidence off a risk path', () => {
  const crit = { severity: 'critical', confidence: 99, file: 'plain/util.ts', line: 1 };
  assert.deepEqual(selectForVerification([crit], DEFAULT_VERIFY, { riskPaths: [] }), [crit]);
  // a high-confidence important off a risk path is still trusted (not selected)
  const imp = { severity: 'important', confidence: 99, file: 'plain/util.ts', line: 1 };
  assert.deepEqual(selectForVerification([imp], DEFAULT_VERIFY, { riskPaths: [] }), []);
});

// --- integration-review regression fixes ---

test('WS6: default gate warns on important (warn_on became [important], not the dead [high])', () => {
  // renderVerdict default fallback + renderReport default gate both warn on important now
  assert.equal(renderVerdict([{ severity: 'important', confidence: 100 }], {}).verdict, 'WARN');
  const md = renderReport({ findings: [{ dimension: 'D2', severity: 'important', file: 'a.ts', line: 1, title: 'x', confidence: 95 }], criteria: [], tier: 'standard' });
  assert.match(md, /## Verdict: WARN/);          // was silently APPROVE while warn_on was the impossible "high"
  // WARN is still exit 0 — no CI-gate behavior change
  assert.equal(renderVerdict([{ severity: 'important', confidence: 100 }], {}).exitCode, 0);
});

test('WS6×WS4: a sub-80 out-of-diff bug is an observation, not a confirmed pre-existing bug', () => {
  const oos = [
    { severity: 'important', title: 'hiconf', confidence: 90 },
    { severity: 'important', title: 'lowconf', confidence: 70 },   // surfaced only at --effort high (reportConf 60)
    { severity: 'critical', title: 'critNoConf' },                 // no confidence → trusted → pre-existing
  ];
  const { preExisting, observations } = partitionOutOfDiff(oos);
  assert.deepEqual(preExisting.map(f => f.title).sort(), ['critNoConf', 'hiconf']);
  assert.deepEqual(observations.map(f => f.title), ['lowconf']);   // sub-80 demoted out of the 🟣 tier
});

test('WS3×WS4: last-review persists only postable (conf>=80) findings, never the Uncertain band', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-lastrev-'));
  try {
    const plan = {
      tier: 'high', base: 'b0', head: 'h1', dimensions: ['D2'], dimensionLabels: { D2: 'Correctness' },
      dimensionAgents: { D2: 'correctness-reviewer' }, models: { D2: 'sonnet' }, agents: ['correctness-reviewer'],
      runVerify: true, sharded: false, shards: [], effort: 'high', verify: { reportConfidence: 60 },
    };
    const data = {
      plan, agentRuns: { 'correctness-reviewer': 1 }, tier: 'high', range: 'b0..h1',
      findings: [
        { dimension: 'D2', severity: 'important', file: 'a.ts', line: 1, title: 'postable', confidence: 90 },
        { dimension: 'D2', severity: 'important', file: 'a.ts', line: 2, title: 'uncertain-band', confidence: 70 },
      ],
    };
    await generateReport(data, { baseDir: tmp });
    const prev = loadLastReview(join(tmp, 'last-review.json'));
    const titles = (prev?.findings ?? []).map(f => f.title);
    assert.ok(titles.includes('postable'), 'the conf>=80 finding is remembered');
    assert.ok(!titles.includes('uncertain-band'), 'the [60,80) surfaced-not-posted finding is NOT remembered (else next run mis-suppresses its first comment)');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
