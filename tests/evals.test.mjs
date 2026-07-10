// Unit tests for the eval harness scorer (evals/score.mjs) plus a smoke test that the runner
// completes offline (no model) with exit 0. No external deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  findingMatchesSeed, matchSeeded, scoreRecallPrecision, scoreVerifyPass,
  scoreCase, aggregate, scoreRun, renderScoreboard, LINE_WINDOW,
} from '../evals/score.mjs';

const seed = (over = {}) => ({ file: 'a.mjs', line: 10, class: 'null-path', description: 'x', ...over });
const finding = (over = {}) => ({ file: 'a.mjs', line: 10, title: 'null deref', evidence: 'user is null here', fix: 'add a guard', ...over });

// --- findingMatchesSeed: file + line-window + class keyword matching ---
test('findingMatchesSeed: exact file+line+keyword matches', () => {
  assert.equal(findingMatchesSeed(finding(), seed()), true);
});

test('findingMatchesSeed: within the line window still matches, the window is inclusive, beyond it fails', () => {
  assert.equal(findingMatchesSeed(finding({ line: 12 }), seed(), 3), true);  // 2 away
  assert.equal(findingMatchesSeed(finding({ line: 13 }), seed(), 3), true);  // 3 away == window, inclusive
  assert.equal(findingMatchesSeed(finding({ line: 14 }), seed(), 3), false); // 4 away, outside the window
});

test('findingMatchesSeed: different file never matches regardless of line', () => {
  assert.equal(findingMatchesSeed(finding({ file: 'b.mjs' }), seed()), false);
});

test('findingMatchesSeed: same file+line but no class keyword in title/evidence/fix fails', () => {
  const f = finding({ title: 'unused variable', evidence: 'x is never read', fix: 'remove it' });
  assert.equal(findingMatchesSeed(f, seed()), false);
});

test('findingMatchesSeed: unknown class falls back to file+line only', () => {
  const f = finding({ title: 'something unrelated', evidence: '', fix: '' });
  assert.equal(findingMatchesSeed(f, seed({ class: 'some-future-class' })), true);
});

test('LINE_WINDOW default is exported and used when no window is passed', () => {
  assert.equal(findingMatchesSeed(finding({ line: 10 + LINE_WINDOW }), seed()), true);
  assert.equal(findingMatchesSeed(finding({ line: 10 + LINE_WINDOW + 1 }), seed()), false);
});

// --- matchSeeded: many-to-many matching ---
test('matchSeeded: one finding can satisfy only its compatible seed; duplicates count once', () => {
  const seeded = [seed({ line: 10 }), seed({ file: 'b.mjs', line: 5, class: 'off-by-one' })];
  const findings = [finding({ line: 10 }), finding({ line: 11 })]; // two findings hit the same seed
  const { matchedSeedIdx, matchedFindingIdx } = matchSeeded(findings, seeded);
  assert.deepEqual([...matchedSeedIdx], [0]);
  assert.deepEqual([...matchedFindingIdx].sort(), [0, 1]);
});

// --- scoreRecallPrecision: recall/precision math ---
test('scoreRecallPrecision: perfect match is 100%/100%', () => {
  const r = scoreRecallPrecision([finding()], [seed()]);
  assert.equal(r.recall, 1);
  assert.equal(r.precision, 1);
  assert.equal(r.truePositives, 1);
  assert.equal(r.falseNegatives, 0);
  assert.equal(r.falsePositives, 0);
});

test('scoreRecallPrecision: a miss halves recall, an extra noisy finding drags precision', () => {
  const seeded = [seed({ line: 10 }), seed({ file: 'b.mjs', line: 5, class: 'off-by-one' })];
  const findings = [finding({ line: 10 }), finding({ file: 'c.mjs', line: 99, title: 'noise', evidence: '', fix: '' })];
  const r = scoreRecallPrecision(findings, seeded);
  assert.equal(r.recall, 0.5);
  assert.equal(r.precision, 0.5);
});

test('scoreRecallPrecision: no seeded bugs -> recall is null, not 0', () => {
  const r = scoreRecallPrecision([finding()], []);
  assert.equal(r.recall, null);
});

test('scoreRecallPrecision: no findings -> precision is null, not 0 (and recall is 0)', () => {
  const r = scoreRecallPrecision([], [seed()]);
  assert.equal(r.precision, null);
  assert.equal(r.recall, 0);
});

// --- scoreVerifyPass: verify-pass value ---
test('scoreVerifyPass: dropped findings with no matching seed are FPs killed (positive value)', () => {
  const dropped = [finding({ file: 'noise.mjs', line: 1, title: 'nit', evidence: '', fix: '' })];
  const r = scoreVerifyPass(dropped, [seed()]);
  assert.equal(r.fpsKilled, 1);
  assert.equal(r.wronglyDropped, 0);
  assert.equal(r.value, 1);
});

test('scoreVerifyPass: dropping a finding that matched a real seeded bug is a wrongly-dropped true positive (negative value)', () => {
  const dropped = [finding()]; // matches seed()
  const r = scoreVerifyPass(dropped, [seed()]);
  assert.equal(r.fpsKilled, 0);
  assert.equal(r.wronglyDropped, 1);
  assert.equal(r.value, -1);
});

test('scoreVerifyPass: nothing dropped is a neutral zero', () => {
  const r = scoreVerifyPass([], [seed()]);
  assert.deepEqual(r, { fpsKilled: 0, wronglyDropped: 0, totalDropped: 0, value: 0 });
});

// --- scoreCase / aggregate / scoreRun ---
test('scoreCase: a skipped case scores null throughout and carries the reason', () => {
  const c = scoreCase({ name: 'x', seeded: [seed()] }, { skipped: true, reason: 'model-gated' });
  assert.equal(c.skipped, true);
  assert.equal(c.reason, 'model-gated');
  assert.equal(c.recall, null);
  assert.equal(c.precision, null);
  assert.equal(c.verifyPass, null);
});

test('scoreCase: a scored case reports recall/precision/verifyPass', () => {
  const c = scoreCase({ name: 'x', seeded: [seed()] }, { findings: [finding()], dropped: [] });
  assert.equal(c.skipped, false);
  assert.equal(c.recall, 1);
  assert.equal(c.precision, 1);
  assert.equal(c.verifyPass.value, 0);
});

test('aggregate: macro-averages recall/precision over scored cases only, counts skipped separately', () => {
  const caseScores = [
    scoreCase({ name: 'a', seeded: [seed()] }, { findings: [finding()], dropped: [] }),         // recall 1, precision 1
    scoreCase({ name: 'b', seeded: [seed()] }, { findings: [], dropped: [] }),                    // recall 0, precision null
    scoreCase({ name: 'c', seeded: [seed()] }, { skipped: true, reason: 'model-gated' }),
  ];
  const agg = aggregate(caseScores);
  assert.equal(agg.totalCases, 3);
  assert.equal(agg.scoredCases, 2);
  assert.equal(agg.skippedCases, 1);
  assert.equal(agg.meanRecall, 0.5);   // (1 + 0) / 2
  assert.equal(agg.meanPrecision, 1);  // only case 'a' has a non-null precision
});

test('scoreRun: matches results to cases by name; an unrecorded case is treated as skipped', () => {
  const cases = [{ name: 'a', seeded: [seed()] }, { name: 'missing', seeded: [] }];
  const results = [{ name: 'a', findings: [finding()], dropped: [] }];
  const scored = scoreRun('2099-01-01', cases, results);
  assert.equal(scored.label, '2099-01-01');
  assert.equal(scored.cases[0].recall, 1);
  assert.equal(scored.cases[1].skipped, true);
  assert.equal(scored.aggregate.skippedCases, 1);
});

test('scoreRun: label is taken verbatim from the parameter (no Date.now inside the scorer)', () => {
  const scored = scoreRun('fixed-label-xyz', [], []);
  assert.equal(scored.label, 'fixed-label-xyz');
});

// --- renderScoreboard: markdown shape ---
test('renderScoreboard: includes the label, aggregate line, and one row per case', () => {
  const cases = [{ name: 'a', seeded: [seed()] }];
  const results = [{ name: 'a', findings: [finding()], dropped: [] }];
  const scored = scoreRun('2099-02-02', cases, results);
  const md = renderScoreboard(scored.label, scored.cases, scored.aggregate);
  assert.match(md, /# Eval scoreboard — 2099-02-02/);
  assert.match(md, /\| a \| scored \| 100% \| 100% \| 0 \| 0 \|/);
});

// --- smoke: the runner completes offline (no model) with exit 0 ---
test('run.mjs completes without a model, exit 0, and writes a scoreboard', () => {
  const RUN = new URL('../evals/run.mjs', import.meta.url).pathname;
  const RESULTS_DIR = new URL('../evals/results', import.meta.url).pathname;
  const label = 'evals-test-smoke';
  const before = new Set(readdirSync(RESULTS_DIR));
  const r = spawnSync(process.execPath, [RUN, '--label', label], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, ACR_EVAL_LIVE: '' },
  });
  try {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /evals: \d+ case\(s\)/);
    const scored = JSON.parse(readFileSync(join(RESULTS_DIR, `${label}.json`), 'utf8'));
    assert.ok(scored.cases.length > 0);
    assert.ok(scored.cases.every((c) => c.skipped), 'every case must be marked skipped with no model available');
  } finally {
    // leave the results dir as we found it — these are the test's own scratch artifacts
    for (const ext of ['json', 'md']) {
      if (!before.has(`${label}.${ext}`)) rmSync(join(RESULTS_DIR, `${label}.${ext}`), { force: true });
    }
  }
});
