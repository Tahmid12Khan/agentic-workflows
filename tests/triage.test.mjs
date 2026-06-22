import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { computeSignals } from '../lib/signals.mjs';
import { planReview } from '../lib/triage.mjs';

const dir = new URL('../fixtures/cases/', import.meta.url);
const cases = readdirSync(dir).map(f => JSON.parse(readFileSync(new URL(f, dir))));

test('computeSignals flags payment path as risky', () => {
  const pay = cases.find(c => c.name === 'payment capture change');
  const s = computeSignals(pay);
  assert.equal(s.riskPaths.includes('payment'), true);
  assert.equal(s.concurrencyTouched, true);
});

test('computeSignals flags trivial doc-only change', () => {
  const t = cases.find(c => c.name === 'doc typo');
  const s = computeSignals(t);
  assert.equal(s.docOnly, true);
});

const DEFAULT_CFG = { risk_map: {}, mandatory_checks: [], gate: { block_on: ['critical'], warn_on: ['high'] } };

test('trivial doc change → trivial tier, minimal dimensions', () => {
  const t = cases.find(c => c.name === 'doc typo');
  const plan = planReview(computeSignals(t), DEFAULT_CFG);
  assert.equal(plan.tier, 'trivial');
  assert.deepEqual(plan.dimensions.sort(), ['D13','D2']);
  assert.equal(plan.runVerify, false);
});

test('payment change → critical tier, security+concurrency mandatory, verify on', () => {
  const p = cases.find(c => c.name === 'payment capture change');
  const plan = planReview(computeSignals(p), DEFAULT_CFG);
  assert.equal(plan.tier, 'critical');
  assert.ok(plan.dimensions.includes('D3'));
  assert.ok(plan.dimensions.includes('D7'));
  assert.equal(plan.runVerify, true);
  assert.equal(plan.models.D3, 'opus');
});

test('normal feature → standard tier, simplifier suggestions, verify on', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const plan = planReview(computeSignals(f), DEFAULT_CFG);
  assert.equal(plan.tier, 'standard');
  assert.ok(plan.dimensions.includes('D16'));
  assert.equal(plan.runVerify, true);
});

test('risk_map config can force a tier floor', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const cfg = { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } };
  const plan = planReview(computeSignals(f), cfg);
  assert.equal(plan.tier, 'critical');
});

test('runVerify is on for every non-trivial tier', () => {
  for (const tier of ['low', 'standard', 'high', 'critical']) {
    const p = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, tier);
    assert.equal(p.runVerify, true, `${tier} should verify`);
  }
  const trivial = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, 'trivial');
  assert.equal(trivial.runVerify, false, 'trivial should not verify');
});
