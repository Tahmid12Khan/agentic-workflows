import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldShard, shardFiles, singleShard } from '../lib/shard.mjs';
import { verifyPolicy, selectForVerification, resolveVerification, partition, lensFor, firstPassModel, shouldEscalate } from '../lib/verify.mjs';
import { applyLearnings, dedupAgainstPrevious, recordRun, findingKey, EMPTY } from '../lib/memory.mjs';
import { renderHtml } from '../lib/render.mjs';
import { parseNpmAudit, parsePipAudit } from '../lib/scan.mjs';
import { extractIssueKeys } from '../lib/gather.mjs';
import { buildCommentBody, buildCommentArgs, commentLocation, dedupComments } from '../lib/comments.mjs';
import { extraScrutinyTargets, forcedChecks, newLedger, canSpawn, recordSpawn } from '../lib/route.mjs';
import { computeSignals } from '../lib/signals.mjs';
import { planReview, exhaustivePlan, pickModels, DIMENSION_AGENTS } from '../lib/triage.mjs';

// --- sharding ---
test('shouldShard triggers on big diffs only', () => {
  assert.equal(shouldShard(100, 5, 600), false);
  assert.equal(shouldShard(900, 5, 600), true);
  assert.equal(shouldShard(100, 50, 600), true);
});
test('shardFiles groups by top dir and caps shard count', () => {
  const files = ['a/1.ts','a/2.ts','b/3.ts','c/4.ts','d/5.ts','e/6.ts'];
  const shards = shardFiles(files, { maxShards: 3 });
  assert.ok(shards.length <= 3);
  assert.equal(shards.flatMap(s => s.files).length, 6);
});
test('singleShard wraps everything in one unit', () => {
  assert.deepEqual(singleShard(['x']), [{ label: 'all', files: ['x'] }]);
});

// --- bounded adversarial verification ---
test('verifyPolicy caps verifier passes so total looks <= 3', () => {
  const p = verifyPolicy({ verify: { max_passes_per_aspect: 3, max_subagents_per_aspect: 3 } });
  assert.equal(p.maxVerifierPasses, 2); // 1 review + 2 verifiers = 3 total
});
test('verifyPolicy never exceeds the agent budget', () => {
  const p = verifyPolicy({ verify: { max_passes_per_aspect: 3, max_subagents_per_aspect: 1 } });
  assert.equal(p.maxVerifierPasses, 1);
});
test('selectForVerification picks low-confidence and uncertain findings', () => {
  const findings = [
    { title: 'a', confidence: 95, severity: 'minor' },
    { title: 'b', confidence: 60, severity: 'important' },
    { title: 'c', confidence: 90, uncertain: true, severity: 'minor' },
  ];
  const sel = selectForVerification(findings, verifyPolicy({}));
  assert.deepEqual(sel.map(f => f.title), ['b', 'c']);
});
test('selectForVerification re-checks high-severity on risk paths even at high conf', () => {
  const f = [{ title: 'authz gap', confidence: 99, severity: 'critical', file: 'src/auth/guard.ts' }];
  const sel = selectForVerification(f, verifyPolicy({}), { riskPaths: ['auth'] });
  assert.equal(sel.length, 1);
});

// --- cheap→strong verifier escalation ---
test('firstPassModel: critical goes straight to the strong model; others get the cheap one', () => {
  const p = verifyPolicy({});                                  // defaults: sonnet→opus, direct=[critical]
  assert.equal(firstPassModel({ severity: 'critical' }, p), 'opus');
  assert.equal(firstPassModel({ severity: 'important' }, p), 'sonnet');
  assert.equal(firstPassModel({ severity: 'minor' }, p), 'sonnet');
});

test('firstPassModel honours configured models + escalate_direct_severity', () => {
  const p = verifyPolicy({ verify: { model_first: 'haiku', model_escalate: 'sonnet', escalate_direct_severity: ['critical', 'important'] } });
  assert.equal(firstPassModel({ severity: 'important' }, p), 'sonnet'); // now direct
  assert.equal(firstPassModel({ severity: 'minor' }, p), 'haiku');      // cheap
});

test('shouldEscalate: uncertain (any severity) and hot-refuted escalate; clean non-hot verdicts do not', () => {
  const p = verifyPolicy({});
  assert.equal(shouldEscalate({ severity: 'minor' }, { verdict: 'uncertain' }, p), true);
  assert.equal(shouldEscalate({ severity: 'important' }, { verdict: 'refuted' }, p), true);  // hot_refuted
  assert.equal(shouldEscalate({ severity: 'minor' }, { verdict: 'refuted' }, p), false);     // not hot
  assert.equal(shouldEscalate({ severity: 'critical' }, { verdict: 'real' }, p), false);     // confirmed, no escalate
  assert.equal(shouldEscalate({ severity: 'important' }, 'refuted', p), true);               // bare-string verdict
});
test('resolveVerification: majority refute drops, majority real keeps', () => {
  const f = { title: 'x', confidence: 60, severity: 'important' };
  const dropped = resolveVerification(f, [{ verdict: 'refuted' }, { verdict: 'refuted' }], verifyPolicy({}));
  assert.equal(dropped.decision, 'drop');
  const kept = resolveVerification(f, [{ verdict: 'real' }, { verdict: 'real' }], verifyPolicy({}));
  assert.equal(kept.decision, 'keep');
  assert.ok(kept.confidence >= 80);
});
test('resolveVerification: tie after cap → needs-human, not silent drop', () => {
  const f = { title: 'x', confidence: 60, severity: 'important' };
  const r = resolveVerification(f, [{ verdict: 'real' }, { verdict: 'refuted' }], verifyPolicy({}));
  assert.equal(r.decision, 'needs-human');
});
test('resolveVerification respects the 3-look cap (ignores extra verdicts)', () => {
  const f = { title: 'x', confidence: 50, severity: 'important' };
  const r = resolveVerification(f, [{ verdict: 'real' }, { verdict: 'real' }, { verdict: 'real' }], verifyPolicy({ verify: { max_passes_per_aspect: 3 } }));
  assert.equal(r.verify.passes, 3); // 1 review + only 2 verifiers counted
  assert.equal(r.verify.capped, true);
});
test('partition routes survivors, drops, and unresolved correctly', () => {
  const resolved = [
    { title: 'keep', decision: 'keep', confidence: 90 },
    { title: 'drop', decision: 'drop', confidence: 90 },
    { title: 'ask', decision: 'needs-human', confidence: 60 },
  ];
  const { report, dropped, needsHuman } = partition(resolved, verifyPolicy({}));
  assert.deepEqual(report.map(f => f.title), ['keep']);
  assert.deepEqual(dropped.map(f => f.title), ['drop']);
  assert.deepEqual(needsHuman.map(f => f.title), ['ask']);
});

// --- memory ---
test('applyLearnings suppresses accepted false-positives and tags recurring', () => {
  const learnings = { ...EMPTY, acceptedFalsePositives: [{ key: findingKey({ file: 'a.ts', title: 'noise' }) }], recurring: [{ key: findingKey({ file: 'b.ts', title: 'real' }), count: 2 }] };
  const { kept, suppressed } = applyLearnings([{ file: 'a.ts', title: 'noise' }, { file: 'b.ts', title: 'real' }], learnings);
  assert.equal(suppressed.length, 1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].recurring, true);
});
test('dedupAgainstPrevious marks new findings for incremental review', () => {
  const prev = [{ file: 'a.ts', title: 'old' }];
  const now = dedupAgainstPrevious([{ file: 'a.ts', title: 'old' }, { file: 'c.ts', title: 'new' }], prev);
  assert.equal(now.find(f => f.title === 'old').isNew, false);
  assert.equal(now.find(f => f.title === 'new').isNew, true);
});
test('recordRun accumulates recurring counts and open questions', () => {
  const after = recordRun(EMPTY, { reported: [{ file: 'a.ts', title: 'x' }], needsHuman: [{ title: 'unsure?', file: 'b.ts' }], range: 'r' });
  assert.equal(after.recurring.length, 1);
  assert.equal(after.unresolved.length, 1);
});

// --- html report ---
test('renderHtml is self-contained and surfaces the needs-human section', () => {
  const html = renderHtml({
    tier: 'critical',
    findings: [{ dimension: 'D3', severity: 'critical', file: 'a.ts', line: 1, title: 'authz', confidence: 95 }],
    criteria: [{ id: 'AC1', text: 'admins only', covered: false }],
    needsHuman: [{ question: 'is this intentional?', file: 'b.ts', line: 9 }],
    gate: { block_on: ['critical'], warn_on: ['high'] },
  });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Needs your input/);
  assert.match(html, /BLOCK/);
  assert.match(html, /authz/);
  assert.doesNotMatch(html, /<script/i); // no JS in the report
});

// --- scan parsers ---
test('parseNpmAudit maps advisories to D15 findings', () => {
  const out = parseNpmAudit({ vulnerabilities: { lodash: { severity: 'high', via: [{ title: 'proto pollution' }], fixAvailable: true } } });
  assert.equal(out.length, 1);
  assert.equal(out[0].dimension, 'D15');
  assert.equal(out[0].severity, 'high');
});
test('parsePipAudit maps vulns to findings', () => {
  const out = parsePipAudit([{ name: 'requests', version: '2.0', vulns: [{ id: 'PYSEC-1', description: 'bad', fix_versions: ['2.31'] }] }]);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /requests/);
});

// --- tracker key extraction ---
test('extractIssueKeys pulls Jira-style keys', () => {
  assert.deepEqual(extractIssueKeys('Fixes PROJ-123 and PROJ-9', '[A-Z][A-Z0-9]+-[0-9]+'), ['PROJ-123', 'PROJ-9']);
});

// --- inline comments ---
test('buildCommentBody includes problem, fix and advisory footer', () => {
  const body = buildCommentBody({ severity: 'important', dimension: 'D2', title: 'off-by-one', evidence: 'i <= len', fix: 'use <', confidence: 88 });
  assert.match(body, /IMPORTANT/);
  assert.match(body, /off-by-one/);
  assert.match(body, /Suggested fix/);
  assert.match(body, /advisory/);
});
test('buildCommentBody renders a GitHub suggestion block when fixCode is set', () => {
  const body = buildCommentBody({ severity: 'important', dimension: 'D2', title: 'off-by-one', evidence: 'i <= len', fix: 'use <', fixCode: 'if (i < len) {', confidence: 88 });
  assert.match(body, /```suggestion\nif \(i < len\) \{\n```/);
  assert.doesNotMatch(body, /Suggested fix:/);
});
test('dedupComments skips already-commented lines', () => {
  const out = dedupComments([{ file: 'a.ts', line: 5, title: 'x' }, { file: 'b.ts', line: 1, title: 'y' }], [{ path: 'a.ts', line: 5, body: 'old' }]);
  assert.deepEqual(out.map(f => f.file), ['b.ts']);
});
test('commentLocation is single-line unless endLine exceeds line', () => {
  assert.deepEqual(commentLocation({ line: 5 }), { line: 5 });
  assert.deepEqual(commentLocation({ line: 5, endLine: 5 }), { line: 5 });
  assert.deepEqual(commentLocation({ line: 5, endLine: 3 }), { line: 5 });
  assert.deepEqual(commentLocation({ line: 5, endLine: 8 }), { line: 8, start_line: 5, start_side: 'RIGHT' });
});
test('buildCommentArgs anchors a multi-line finding with start_line/start_side', () => {
  const args = buildCommentArgs({ file: 'a.ts', line: 10, endLine: 13, severity: 'important', title: 'x', fixCode: 'a\nb' }, { head: 'sha1', pr: 7 });
  assert.deepEqual(args.slice(args.indexOf('-F')), ['-F', 'line=13', '-f', 'side=RIGHT', '-F', 'start_line=10', '-f', 'start_side=RIGHT']);
});
test('dedupComments keys a multi-line finding off its last line (endLine)', () => {
  const out = dedupComments([{ file: 'a.ts', line: 10, endLine: 13, title: 'x' }], [{ path: 'a.ts', line: 13, body: 'old' }]);
  assert.equal(out.length, 0);
});

// --- triage wiring for new dimensions ---
test('planReview routes UI changes to D17 and maps an agent for it', () => {
  const s = computeSignals({ files: ['src/widget.tsx'], netLoc: 50, testsPresent: true });
  const plan = planReview(s, { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } });
  assert.ok(plan.dimensions.includes('D17'));
  assert.equal(DIMENSION_AGENTS.D17, 'a11y-i18n-reviewer');
});
test('every planned dimension has a bundled agent', () => {
  const s = computeSignals({ files: ['src/payment/Capture.java'], netLoc: 60, testsPresent: true, concurrencyTouched: true });
  const plan = planReview(s, { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } });
  for (const d of plan.dimensions) assert.ok(DIMENSION_AGENTS[d], `no agent for ${d}`);
});
test('standard feature plan includes the test-adequacy dimension D5', () => {
  const s = computeSignals({ files: ['src/profile/profileService.ts', 'src/profile/profileService.test.ts'], netLoc: 90, testsPresent: true });
  const plan = planReview(s, { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } });
  assert.equal(plan.tier, 'standard');
  assert.ok(plan.dimensions.includes('D5'));
});
test('D6 uses opus on migrations, sonnet otherwise', () => {
  const cfg = { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } };
  const mig = planReview(computeSignals({ files: ['db/0007.sql'], netLoc: 30 }), cfg);
  assert.equal(mig.models.D6, 'opus');
  const java = planReview(computeSignals({ files: ['src/Svc.java'], netLoc: 30, concurrencyTouched: true }), cfg);
  assert.ok(java.dimensions.includes('D6'));
  assert.equal(java.models.D6, 'sonnet');
});
test('planReview --tier override recomputes the plan, not just the label', () => {
  const cfg = { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } };
  const s = computeSignals({ files: ['docs/readme.md'], netLoc: 2 }); // would triage to trivial
  const base = planReview(s, cfg);
  assert.equal(base.tier, 'trivial');
  assert.equal(base.runVerify, false);
  const forced = planReview(s, cfg, 'critical');
  assert.equal(forced.tier, 'critical');
  assert.equal(forced.runVerify, true);          // recomputed from the forced tier
  assert.ok(forced.dimensions.includes('D3'));   // not present at trivial
});

// --- deterministic routing ---
test('extraScrutinyTargets picks flagged and out-of-scope extra groups', () => {
  const out = extraScrutinyTargets({ groups: [
    { label: 'feature', kind: 'primary', withinScope: true, scrutinize: false, files: ['a.ts'] },
    { label: 'drive-by refactor', kind: 'extra', withinScope: false, files: ['b.ts'], note: 'unrelated' },
    { label: 'flagged', kind: 'extra', withinScope: true, scrutinize: true, files: ['c.ts'] },
  ] });
  assert.deepEqual(out.map(t => t.label), ['drive-by refactor', 'flagged']);
  assert.equal(out[0].reason, 'unrelated');
});
test('forcedChecks maps mandatory checks to a dimension', () => {
  const out = forcedChecks(['no secrets or tokens committed', 'new behavior is covered by a test', 'just be nice']);
  assert.equal(out[0].dimension, 'D3');
  assert.equal(out[1].dimension, 'D5');
  assert.equal(out[2].dimension, null);
});
test('spawn ledger enforces the <=3-subagents-per-aspect cap', () => {
  const l = newLedger();
  const k = 'verify:src/auth.ts:42';
  assert.equal(canSpawn(l, k, 3), true);
  assert.equal(recordSpawn(l, k, 3).count, 1);
  recordSpawn(l, k, 3); recordSpawn(l, k, 3);
  assert.equal(canSpawn(l, k, 3), false);
  assert.equal(recordSpawn(l, k, 3).capped, true); // 4th refused
  assert.equal(canSpawn(l, 'review:D3:shardB', 3), true); // other aspects unaffected
});

test('soundness: a single "real" vote cannot bootstrap a low-confidence finding', () => {
  const f = { title: 'weak', confidence: 55, severity: 'minor' };
  const one = resolveVerification(f, [{ verdict: 'real' }], verifyPolicy({}));
  assert.equal(one.decision, 'needs-human'); // one confirm is not enough for a weak finding
  const two = resolveVerification(f, [{ verdict: 'real' }, { verdict: 'real' }], verifyPolicy({}));
  assert.equal(two.decision, 'keep');
});

// --- A1: symmetric burden of proof on the DROP path (high cost-of-miss) ---
test('a high-severity finding is NOT dropped on a single refuter → needs-human', () => {
  const crit = { title: 'authz gap', confidence: 99, severity: 'critical', file: 'src/auth/guard.ts' };
  const r = resolveVerification(crit, [{ verdict: 'refuted' }], verifyPolicy({}));
  assert.equal(r.decision, 'needs-human'); // lone refutation of a high-stakes finding must not silently drop it
  const r2 = resolveVerification(crit, [{ verdict: 'refuted' }, { verdict: 'refuted' }], verifyPolicy({}));
  assert.equal(r2.decision, 'drop'); // two refutations still drop it
});
test('a low-severity finding still drops on a single refuter', () => {
  const minor = { title: 'nit', confidence: 85, severity: 'minor' };
  const r = resolveVerification(minor, [{ verdict: 'refuted' }], verifyPolicy({}));
  assert.equal(r.decision, 'drop');
});

// --- A1 hole: starved budget must not make false criticals undroppable ---
test('under a starved budget (maxVerifierPasses<2) a lone refuter still drops a hot finding', () => {
  const p = verifyPolicy({ verify: { max_subagents_per_aspect: 1 } });
  assert.equal(p.maxVerifierPasses, 1);
  const crit = { title: 'authz', confidence: 99, severity: 'critical', file: 'src/auth/x.ts' };
  const r = resolveVerification(crit, [{ verdict: 'refuted' }], p);
  assert.equal(r.decision, 'drop'); // not permanently stuck in needs-human
});
test('with escalate_uncertain:false a hot finding drops on a single refuter (no needs-human)', () => {
  const p = verifyPolicy({ verify: { escalate_uncertain: false } });
  const crit = { title: 'authz', confidence: 99, severity: 'critical' };
  assert.equal(resolveVerification(crit, [{ verdict: 'refuted' }], p).decision, 'drop');
});

// --- A3: a finding with no confidence is not a free pass (end to end) ---
test('selectForVerification force-verifies a finding missing a confidence score', () => {
  const sel = selectForVerification([{ title: 'unscored', severity: 'important' }], verifyPolicy({}));
  assert.equal(sel.length, 1);
});
test('an unscored finding is selected even with reverify_below:0 (null != 0)', () => {
  const sel = selectForVerification([{ title: 'unscored', severity: 'minor' }], verifyPolicy({ verify: { reverify_below: 0 } }));
  assert.equal(sel.length, 1);
});
test('an unscored finding must earn its place: one "real" vote is not enough', () => {
  const f = { title: 'unscored', severity: 'important' }; // no confidence
  assert.equal(resolveVerification(f, [{ verdict: 'real' }], verifyPolicy({})).decision, 'needs-human');
});
test('an unscored survivor with zero verdicts does not ship to the report', () => {
  const r = resolveVerification({ title: 'unscored', severity: 'minor' }, [], verifyPolicy({}));
  const { report, needsHuman } = partition([r], verifyPolicy({}));
  assert.equal(report.length, 0);
  assert.equal(needsHuman.length, 1);
});

// --- A2 hole: unknown --tier must not yield an empty no-op plan ---
test('planReview ignores an unknown --tier value and falls back (no empty plan)', () => {
  const cfg = { risk_map: {}, gate: { block_on: ['critical'], warn_on: ['high'] } };
  const s = computeSignals({ files: ['src/profile/profileService.ts', 'src/profile/profileService.test.ts'], netLoc: 90, testsPresent: true });
  const bogus = planReview(s, cfg, 'crit'); // typo
  assert.equal(bogus.tier, 'standard');     // fell back to baseTier, not '' / no-op
  assert.ok(bogus.dimensions.length > 0);
  const auto = planReview(s, cfg, 'auto');
  assert.ok(auto.dimensions.length > 0);
});

// --- A2 hole: --dimensions must recompute models (pickModels) ---
test('pickModels assigns a model to every dimension (opus on hot, tier model else)', () => {
  const m = pickModels(['D3', 'D17'], 'standard', {});
  assert.equal(m.D3, 'opus');   // hot dimension
  assert.equal(m.D17, 'sonnet'); // not left undefined
});

// --- Tier C gate ---
test('exhaustivePlan: off by default, on at critical or with --exhaustive', () => {
  assert.equal(exhaustivePlan('standard', {}).exhaustive, false);
  assert.equal(exhaustivePlan('critical', {}).exhaustive, true);
  assert.equal(exhaustivePlan('standard', {}, { flag: true }).exhaustive, true);
  assert.equal(exhaustivePlan('critical', { exhaustive: { on_critical: false } }).exhaustive, false);
  assert.equal(exhaustivePlan('critical', {}).maxRounds, 2);
});

// --- B7: per-dimension adversarial lens ---
test('lensFor routes each dimension to its angle of attack, else correctness', () => {
  assert.equal(lensFor({ dimension: 'D3' }).lens, 'security');
  assert.equal(lensFor({ dimension: 'D7' }).lens, 'concurrency');
  assert.equal(lensFor({ dimension: 'D8' }).lens, 'resources'); // not the D6 migration focus
  assert.equal(lensFor({ dimension: 'D4' }).lens, 'error-handling');
  assert.equal(lensFor({ dimension: 'D2' }).lens, 'correctness');
  assert.equal(lensFor({}).lens, 'correctness');
  assert.ok(lensFor({ dimension: 'D3' }).focus.length > 0);
});
test('D3 findings route to the dedicated taint-verifier agent', () => {
  assert.equal(lensFor({ dimension: 'D3' }).agent, 'taint-verifier');
  assert.equal(lensFor({ dimension: 'D7' }).agent, undefined); // others use the generic finding-verifier
});
test('resolveVerification records which lenses voted', () => {
  const f = { title: 'x', confidence: 60, severity: 'important' };
  const r = resolveVerification(f, [{ verdict: 'real', lens: 'security' }, { verdict: 'real', lens: 'security' }], verifyPolicy({}));
  assert.deepEqual(r.verify.lenses, ['security']);
});
