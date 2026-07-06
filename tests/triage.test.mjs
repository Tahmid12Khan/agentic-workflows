import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { computeSignals } from '../lib/signals.mjs';
import { planReview, pickModels, capTier } from '../lib/triage.mjs';

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

test('normal feature → standard tier, D16 opt-in below high, verify on', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const plan = planReview(computeSignals(f), DEFAULT_CFG);
  assert.equal(plan.tier, 'standard');
  // S5.2: simplification (D16) is a taste pass, trimmed to opt-in below the high tier
  assert.equal(plan.dimensions.includes('D16'), false);
  assert.equal(plan.runVerify, true);
});

test('S5.2: always_dims brings D16 back on standard; --dimensions is the other opt-in', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const withD16 = planReview(computeSignals(f), { ...DEFAULT_CFG, always_dims: ['D16'] });
  assert.equal(withD16.tier, 'standard');
  assert.ok(withD16.dimensions.includes('D16'));
  assert.ok(withD16.agents.includes('simplification-reviewer'));
  // an unknown id in always_dims is ignored, not carried into the plan
  const bogus = planReview(computeSignals(f), { ...DEFAULT_CFG, always_dims: ['D999'] });
  assert.equal(bogus.dimensions.includes('D999'), false);
});

test('S5.2: D16 still ships by default on the high tier (not opt-in there)', () => {
  const plan = planReview({ riskPaths: [], languages: [], callsLlm: false }, DEFAULT_CFG, 'high');
  assert.ok(plan.dimensions.includes('D16'));
});

test('S5.1: model = f(dimension, tier) — no opus below high, opus dims escalate at high+', () => {
  const std = pickModels(['D3', 'D7', 'D9', 'D2'], 'standard', {});
  for (const d of ['D3', 'D7', 'D9', 'D2']) assert.equal(std[d], 'sonnet', `${d} must be sonnet on standard`);
  const high = pickModels(['D3', 'D7', 'D9', 'D2'], 'high', {});
  assert.equal(high.D3, 'opus');
  assert.equal(high.D7, 'opus');
  assert.equal(high.D9, 'opus');
  assert.equal(high.D2, 'sonnet');
  assert.equal(pickModels(['D3'], 'trivial', {}).D3, 'haiku'); // tier base model at trivial
});

test('S5.1: a risk_map floor raising the tier is what earns opus on standard-tier code', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const s = computeSignals(f);
  // without a floor: standard tier, no opus even on a hard dimension added via --dimensions-style set
  assert.equal(pickModels([...planReview(s, DEFAULT_CFG).dimensions, 'D3'], 'standard', {}).D3, 'sonnet');
  // with a floor raising it to critical, the hard dimension gets opus (post-matrix, via the tier)
  const forced = planReview(s, { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } });
  assert.equal(forced.tier, 'critical');
  assert.equal(pickModels([...forced.dimensions, 'D3'], forced.tier, s).D3, 'opus');
});

test('S5.1: migration escalates D6 to opus even below high (post-matrix override)', () => {
  const m = pickModels(['D6', 'D2'], 'standard', { riskPaths: ['migration'] });
  assert.equal(m.D6, 'opus');   // migration override fires regardless of tier
  assert.equal(m.D2, 'sonnet'); // everything else stays on the tier base model
});

test('S5.1: config.models overrides the matrix (opus_dims, opus_min_tier, by_tier)', () => {
  // move the opus floor down to standard
  const lower = pickModels(['D3'], 'standard', {}, { models: { opus_min_tier: 'standard' } });
  assert.equal(lower.D3, 'opus');
  // redefine which dimensions are hard
  const redef = pickModels(['D4', 'D3'], 'high', {}, { models: { opus_dims: ['D4'] } });
  assert.equal(redef.D4, 'opus');
  assert.equal(redef.D3, 'sonnet');
  // override the per-tier base model
  const base = pickModels(['D2'], 'standard', {}, { models: { by_tier: { standard: 'haiku' } } });
  assert.equal(base.D2, 'haiku');
});

test('risk_map config can force a tier floor', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const cfg = { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } };
  const plan = planReview(computeSignals(f), cfg);
  assert.equal(plan.tier, 'critical');
});

test('an explicit --tier is authoritative: risk_map cannot raise it', () => {
  // Same files that risk_map would escalate to critical on the AUTO path...
  const f = cases.find(c => c.name === 'normal feature');
  const cfg = { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } };
  assert.equal(planReview(computeSignals(f), cfg).tier, 'critical');       // auto: risk_map escalates
  // ...but when the user pins --tier standard, it STAYS standard (no silent escalation).
  const pinned = planReview(computeSignals(f), cfg, 'standard');
  assert.equal(pinned.tier, 'standard');
});

test('--max-tier clamps ONLY the auto-computed tier, never the explicit --tier', () => {
  const f = cases.find(c => c.name === 'normal feature');
  const cfg = { ...DEFAULT_CFG, risk_map: { critical: ['src/profile/**'] } };
  // auto path escalates to critical, then --max-tier=standard clamps it back down
  const capped = planReview(computeSignals(f), cfg, undefined, 'standard');
  assert.equal(capped.tier, 'standard');
  // a below-ceiling auto tier passes through untouched (no raise)
  const lower = planReview(computeSignals(f), DEFAULT_CFG, undefined, 'high');
  assert.equal(lower.tier, 'standard');
  // explicit --tier is authoritative and IGNORES the cap (pinned high survives a standard ceiling)
  const pinned = planReview(computeSignals(f), cfg, 'high', 'standard');
  assert.equal(pinned.tier, 'high');
});

test('capTier only lowers: an unknown/absent ceiling is a no-op, never raises', () => {
  assert.equal(capTier('critical', 'standard'), 'standard'); // clamp down
  assert.equal(capTier('low', 'high'), 'low');               // below ceiling → unchanged
  assert.equal(capTier('standard', undefined), 'standard');  // no ceiling → unchanged
  assert.equal(capTier('standard', 'bogus'), 'standard');    // unknown ceiling → unchanged
});

test('runVerify is on for every non-trivial tier', () => {
  for (const tier of ['low', 'standard', 'high', 'critical']) {
    const p = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, tier);
    assert.equal(p.runVerify, true, `${tier} should verify`);
  }
  const trivial = planReview({ riskPaths: [], languages: [], callsLlm: false }, {}, 'trivial');
  assert.equal(trivial.runVerify, false, 'trivial should not verify');
});
