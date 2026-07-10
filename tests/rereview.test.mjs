// WS3 unit tests: re-review convergence (lib/rereview.mjs), the nit cap (lib/comments.mjs's
// capNits), and an end-to-end acceptance check on report.mjs's "Still open" section + round
// counter (the two-run fixture from plan.md's WS3 acceptance criteria).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffFindings, classifyVanished, nextRound, nitConvergence } from '../lib/rereview.mjs';
import { capNits } from '../lib/comments.mjs';
import { buildLastReview } from '../lib/memory.mjs';
import { generateReport } from '../lib/report.mjs';

// --- diffFindings ---

test('diffFindings classifies resolved/persisting/new, tolerating line drift (same file+title = same finding)', () => {
  const prev = [
    { file: 'a.ts', title: 'null deref', line: 10, severity: 'important' },
    { file: 'b.ts', title: 'off-by-one', line: 20, severity: 'minor' },
    { file: 'c.ts', title: 'sql injection', line: 5, severity: 'critical' },
  ];
  const curr = [
    { file: 'b.ts', title: 'off-by-one', line: 25, severity: 'minor' },   // drifted line — still "the same finding"
    { file: 'c.ts', title: 'sql injection', line: 5, severity: 'critical' },
    { file: 'd.ts', title: 'new bug', line: 1, severity: 'important' },
  ];
  const { resolved, persisting, new: news } = diffFindings(prev, curr);
  assert.deepEqual(resolved.map((f) => f.title), ['null deref']);
  assert.deepEqual(persisting.map((f) => f.title).sort(), ['off-by-one', 'sql injection']);
  assert.equal(persisting.find((f) => f.title === 'off-by-one').line, 25);   // curr's (drifted) line survives
  assert.deepEqual(news.map((f) => f.title), ['new bug']);
});

test('diffFindings never collapses two distinct findings that happen to share a key', () => {
  const curr = [
    { file: 'a.ts', title: 'generic issue', line: 5 },
    { file: 'a.ts', title: 'generic issue', line: 50 },
  ];
  const { new: news } = diffFindings([], curr);
  assert.equal(news.length, 2);
});

test('diffFindings on no prior state: everything is new', () => {
  const curr = [{ file: 'a.ts', title: 'x' }];
  assert.deepEqual(diffFindings([], curr), { resolved: [], persisting: [], new: curr });
  assert.deepEqual(diffFindings(undefined, curr).new, curr);
});

// --- classifyVanished: the vanished-without-code-change case ---

test('classifyVanished: resolved only when the OLD file:line region actually changed', () => {
  const candidates = [
    { file: 'a.ts', title: 'fixed bug', line: 10 },
    { file: 'b.ts', title: 'model variance', line: 40 },
  ];
  const diffIndex = { 'a.ts': [[8, 12]] };   // a.ts changed near line 10; b.ts wasn't touched at all
  const { resolved, notReproduced } = classifyVanished(candidates, diffIndex);
  assert.deepEqual(resolved.map((f) => f.title), ['fixed bug']);
  assert.deepEqual(notReproduced.map((f) => f.title), ['model variance']);
});

test('classifyVanished: no diff available (empty diffIndex) never falsely claims a fix', () => {
  const candidates = [{ file: 'a.ts', title: 'x', line: 10 }];
  const { resolved, notReproduced } = classifyVanished(candidates, {});
  assert.equal(resolved.length, 0);
  assert.equal(notReproduced.length, 1);
});

// --- nextRound (convergence round counter) ---

test('nextRound: bumps on a continuing PR, restarts at 1 for a different PR / no prior state', () => {
  assert.equal(nextRound(null, { prNumber: 5 }), 1);
  assert.equal(nextRound({ prNumber: 5, round: 1 }, { prNumber: 5 }), 2);
  assert.equal(nextRound({ prNumber: 5, round: 2 }, { prNumber: 5 }), 3);
  assert.equal(nextRound({ prNumber: 5, round: 3 }, { prNumber: 6 }), 1);   // different PR
  assert.equal(nextRound({ base: 'B', round: 4 }, { base: 'B' }), 5);       // no PR context — base identity
  assert.equal(nextRound({ base: 'B', round: 4 }, { base: 'C' }), 1);       // different base
  assert.equal(nextRound({ base: 'B', round: 'not-a-number' }, { base: 'B' }), 2);   // corrupt round degrades to 1, then bumps
});

// --- nitConvergence (rereview.nit_rounds policy) ---

test('nitConvergence: minor/suggestion go report-only from round nitRounds+1 on; critical/important never affected', () => {
  const findings = [
    { severity: 'critical', title: 'c' },
    { severity: 'important', title: 'i' },
    { severity: 'minor', title: 'm' },
    { severity: 'suggestion', title: 's' },
  ];
  assert.deepEqual(nitConvergence(findings, 1, 1), { postable: findings, reportOnly: [] });
  const r2 = nitConvergence(findings, 2, 1);
  assert.deepEqual(r2.reportOnly.map((f) => f.title).sort(), ['m', 's']);
  assert.deepEqual(r2.postable.map((f) => f.title).sort(), ['c', 'i']);
  // raising nit_rounds keeps nits postable for longer
  assert.deepEqual(nitConvergence(findings, 2, 2).reportOnly, []);
});

// --- capNits (report.max_posted_nits) ---

test('capNits: posts the top-N nits by confidence (stable sort: confidence desc, then file, then line); critical/important never capped', () => {
  const findings = [
    { severity: 'critical', title: 'crit', confidence: 50 },
    { severity: 'minor', title: 'm1', confidence: 70, file: 'b.ts', line: 5 },
    { severity: 'minor', title: 'm2', confidence: 90, file: 'a.ts', line: 1 },
    { severity: 'suggestion', title: 's1', confidence: 90, file: 'a.ts', line: 2 },
    { severity: 'suggestion', title: 's2', confidence: 60, file: 'c.ts', line: 1 },
  ];
  const { posted, droppedCount, dropped } = capNits(findings, 2);
  assert.deepEqual(posted.map((f) => f.title).sort(), ['crit', 'm2', 's1']);
  assert.equal(droppedCount, 2);
  assert.deepEqual(dropped.map((f) => f.title).sort(), ['m1', 's2']);
});

test('capNits selection is deterministic regardless of input order (tie-break: file, then line)', () => {
  const findings = [
    { severity: 'minor', title: 'a', confidence: 80, file: 'z.ts', line: 1 },
    { severity: 'minor', title: 'b', confidence: 80, file: 'a.ts', line: 1 },
  ];
  const forward = capNits(findings, 1);
  const reversed = capNits([...findings].reverse(), 1);
  assert.deepEqual(forward.posted.map((f) => f.title), reversed.posted.map((f) => f.title));
  assert.deepEqual(forward.posted.map((f) => f.title), ['b']);   // a.ts sorts before z.ts on a confidence tie
});

test('capNits with maxPostedNits large enough to cover every nit drops nothing', () => {
  const findings = [{ severity: 'minor', title: 'm', confidence: 80 }];
  const { droppedCount } = capNits(findings, 5);
  assert.equal(droppedCount, 0);
});

// --- acceptance: the two-run fixture from plan.md's WS3 acceptance criteria ---
// Run 1 (simulated via a hand-written last-review.json): three findings reported for PR #7.
// Run 2: one is fixed (no longer reported), two persist unchanged → the report must say
// "Still open (2)" and the round counter must have advanced.

test('acceptance: a re-review with one fixed + two persisting findings renders "Still open (2)" and bumps the round', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-rereview-'));
  const baseDir = join(tmp, '.adversarial-code-review');
  try {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, 'last-review.json'), JSON.stringify(buildLastReview({
      base: 'B0', head: 'H0', range: 'B0..H0', round: 1, prNumber: 7,
      findings: [
        { file: 'a.ts', title: 'fixed bug', dimension: 'D2', severity: 'important', line: 10 },
        { file: 'b.ts', title: 'still bug 1', dimension: 'D2', severity: 'minor', line: 5 },
        { file: 'c.ts', title: 'still bug 2', dimension: 'D1', severity: 'suggestion', line: 20 },
      ],
    })));
    const plan = {
      tier: 'standard', base: 'B0', head: 'H1', range: 'H0..H1', dimensions: ['D2'], dimensionLabels: { D2: 'Correctness' },
      dimensionAgents: { D2: 'correctness-reviewer' }, models: { D2: 'sonnet' }, runVerify: false, sharded: false, shards: [], agents: ['correctness-reviewer'],
    };
    const payload = {
      tier: 'standard', range: 'H0..H1', prNumber: 7,
      findings: [
        { dimension: 'D2', severity: 'minor', file: 'b.ts', line: 5, title: 'still bug 1', confidence: 90 },
        { dimension: 'D1', severity: 'suggestion', file: 'c.ts', line: 20, title: 'still bug 2', confidence: 90 },
      ],
      gate: { block_on: ['critical'], warn_on: ['high'] },
      plan, agentRuns: { 'correctness-reviewer': 1 },
    };
    const res = await generateReport(payload, { baseDir });
    assert.equal(res.ok, true);
    const md = readFileSync(join(res.folderPath, 'review.md'), 'utf8');
    assert.match(md, /## Still open \(2\)/);
    assert.match(md, /still bug 1.*persisting|persisting.*still bug 1/s);
    const last = JSON.parse(readFileSync(join(baseDir, 'last-review.json'), 'utf8'));
    assert.equal(last.round, 2);
    assert.equal(last.prNumber, 7);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
