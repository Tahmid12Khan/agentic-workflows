// WS4: effort levels end to end — the plan.mjs CLI flag, the render-layer "Uncertain (verify
// manually)" band + header line, and the gate-invariance guarantee (report threshold and gate
// confidence are two separate mechanisms; effort only ever moves the former).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { renderReport, renderHtml, renderVerdict, splitUncertain, effortLine } from '../lib/render.mjs';
import { generateReport } from '../lib/report.mjs';

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const REPO = fileURLToPath(new URL('../', import.meta.url));
const node = process.execPath;

function runPlan(args = []) {
  return JSON.parse(execFileSync(node, [join(LIB, 'plan.mjs'), ...args], { cwd: REPO, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
}

// --- plan.mjs: --effort flag parsing + wiring ---

test('plan.mjs --effort: defaults to medium and carries plan.effort', () => {
  const medium = runPlan();
  assert.equal(medium.effort, 'medium');
  assert.equal(medium.verify.reportConfidence, 80); // identity: matches render.mjs's fixed gate floor
});

test('plan.mjs --effort: an unrecognized value falls back to medium', () => {
  assert.equal(runPlan(['--effort', 'bogus']).effort, 'medium');
});

test('plan.mjs --effort: never changes tier or gate, whatever the level', () => {
  const medium = runPlan();
  for (const level of ['low', 'high', 'max']) {
    const out = runPlan(['--effort', level]);
    assert.equal(out.tier, medium.tier, `${level} must not change tier`);
    assert.deepEqual(out.gate, medium.gate, `${level} must not touch the gate`);
  }
});

test('plan.mjs --effort: low raises the report bar and trims a verifier seat; high/max lower it and broaden coverage', () => {
  const medium = runPlan();
  const low = runPlan(['--effort', 'low']);
  const high = runPlan(['--effort', 'high']);
  const max = runPlan(['--effort', 'max']);
  assert.equal(low.verify.reportConfidence, 90);
  assert.equal(high.verify.reportConfidence, 60);
  assert.equal(max.verify.reportConfidence, 60);
  assert.equal(low.verify.maxVerifierAgents, Math.max(1, medium.verify.maxVerifierAgents - 1));
  assert.ok(high.verify.maxVerifierAgents >= 8);
  assert.ok(max.verify.maxVerifierAgents >= 8);
});

test('plan.mjs --effort max implies --exhaustive and disables fan-out trim', () => {
  const max = runPlan(['--effort', 'max']);
  assert.equal(max.exhaustive, true);
  assert.equal(max.discovery.exhaustive, true);
});

test('interaction: --exhaustive + --effort low → exhaustive wins on passes, low wins on the report threshold', () => {
  const combo = runPlan(['--exhaustive', '--effort', 'low']);
  assert.equal(combo.exhaustive, true);            // exhaustive passes still run
  assert.equal(combo.verify.reportConfidence, 90);  // but the report bar stays low's strict 90
});

// --- render layer: gate invariance ---

test('gate invariance at the render layer: renderVerdict takes no report-threshold argument at all', () => {
  // a 70-confidence critical would land in the "Uncertain" band under high/max's report bar (60),
  // but the gate never sees a report threshold — it must never block/warn on it.
  const findings = [{ severity: 'critical', confidence: 70 }];
  const gate = { block_on: ['critical'], warn_on: ['high'] };
  assert.equal(renderVerdict(findings, gate, 'standard').verdict, 'APPROVE');
  // the SAME findings passed through renderReport (with a low report threshold) still resolve APPROVE
  const md = renderReport({ findings, criteria: [], tier: 'standard', effort: 'high', reportThreshold: 60 });
  assert.match(md, /## Verdict: APPROVE/);
});

// --- render layer: splitUncertain + the dedicated section + the header line ---

test('splitUncertain: empty at medium and low (band inverted/zero-width), populated at high/max', () => {
  const findings = [
    { title: 'solid', confidence: 90 },
    { title: 'borderline', confidence: 70 },
    { title: 'weak', confidence: 55 },
  ];
  assert.deepEqual(splitUncertain(findings, 80).map(f => f.title), []);              // medium
  assert.deepEqual(splitUncertain(findings, 90).map(f => f.title), []);              // low: band inverted, empty
  assert.deepEqual(splitUncertain(findings, 60).map(f => f.title), ['borderline']);  // high/max
  assert.deepEqual(splitUncertain(findings, null).map(f => f.title), []);            // no threshold recorded → identity
});

test('high/max effort surfaces the sub-gate band as a dedicated "Uncertain (verify manually)" section', () => {
  const findings = [
    { dimension: 'D2', severity: 'important', file: 'a.ts', line: 1, title: 'solid finding', confidence: 90 },
    { dimension: 'D4', severity: 'minor', file: 'b.ts', line: 2, title: 'borderline finding', confidence: 70, evidence: 'ev', fix: 'fix it' },
  ];
  const md = renderReport({ findings, criteria: [], tier: 'standard', effort: 'high', reportThreshold: 60 });
  assert.match(md, /## Uncertain \(verify manually\) \(1\)/);
  assert.match(md, /borderline finding/);
  // not double-listed: the Important section (bounded to before Uncertain) holds only the solid one
  const importantSection = md.slice(md.indexOf('## Important'), md.indexOf('## Uncertain'));
  assert.doesNotMatch(importantSection, /borderline finding/);
  assert.match(md, /## Verdict: WARN/); // conf-90 important warns (default gate); the borderline conf-70 stays OUT of the gate (Uncertain only)

  const html = renderHtml({ findings, criteria: [], tier: 'standard', effort: 'high', reportThreshold: 60 });
  assert.match(html, /Uncertain \(verify manually\)/);
  assert.match(html, /borderline finding/);
});

test('medium effort (or no effort at all) renders no Uncertain section and no Effort line', () => {
  const findings = [{ dimension: 'D2', severity: 'minor', file: 'a.ts', line: 1, title: 'x', confidence: 70 }];
  const md = renderReport({ findings, criteria: [], tier: 'standard' });
  assert.doesNotMatch(md, /Uncertain \(verify manually\)/);
  assert.doesNotMatch(md, /Effort:/);
  const mdMedium = renderReport({ findings, criteria: [], tier: 'standard', effort: 'medium', reportThreshold: 80 });
  assert.doesNotMatch(mdMedium, /Effort:/);
});

test('report header names the effort and what it changed', () => {
  assert.equal(effortLine(null, null), null);
  assert.equal(effortLine('medium', 80), null);
  assert.match(effortLine('high', 60), /Effort: high — report bar lowered to ≥60/);
  assert.match(effortLine('max', 60), /Effort: max — report bar lowered to ≥60/);
  assert.match(effortLine('low', 90), /Effort: low — report bar raised to ≥90/);

  const mdHigh = renderReport({ findings: [], criteria: [], tier: 'standard', effort: 'high', reportThreshold: 60 });
  assert.match(mdHigh, /Effort: high — report bar lowered to ≥60/);
  const htmlLow = renderHtml({ findings: [], criteria: [], tier: 'standard', effort: 'low', reportThreshold: 90 });
  assert.match(htmlLow, /Effort: low — report bar raised to ≥90/);
});

// --- report.mjs: low effort drops "needs your input" instead of surfacing it ---

const BASE_PLAN = (effort, reportConfidence) => ({
  tier: 'standard', effort, verify: { reportConfidence },
  dimensions: [], models: {}, agents: [], runVerify: true, sharded: false, shards: [],
});

test('report.mjs (low effort): needs-human findings are dropped, never surfaced', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'acr-effort-'));
  const res = await generateReport({
    plan: BASE_PLAN('low', 90), agentRuns: {}, findings: [],
    needsHuman: ['Should X cascade to Y?'],
  }, { baseDir });
  assert.equal(res.ok, true);
  const md = readFileSync(join(res.folderPath, 'review.md'), 'utf8');
  assert.doesNotMatch(md, /Needs your input/);
  assert.doesNotMatch(md, /Should X cascade to Y/);
});

test('report.mjs (medium/high effort): needs-human findings are still surfaced', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'acr-effort-'));
  const res = await generateReport({
    plan: BASE_PLAN('medium', 80), agentRuns: {}, findings: [],
    needsHuman: ['Should X cascade to Y?'],
  }, { baseDir });
  const md = readFileSync(join(res.folderPath, 'review.md'), 'utf8');
  assert.match(md, /Needs your input/);
  assert.match(md, /Should X cascade to Y/);
});
