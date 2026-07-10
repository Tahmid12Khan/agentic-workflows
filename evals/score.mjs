#!/usr/bin/env node
// CLI + library: score a review run's findings against the seeded ground-truth bugs in
// evals/cases/*.json. This is the regression gate for prompt/doctrine changes (WS1/WS8) — a
// change that drops recall on this scoreboard is a quality regression, not a style nit.
// Usage: node score.mjs --label <label> [--in <run.json>] [--out-dir <dir>]
//   Reads { cases: [{name, seeded, cleanFiles}], results: [{name, findings, dropped, skipped, reason}] }
//   from --in or stdin. Prints the scored JSON to stdout and writes
//   evals/results/<label>.json + evals/results/<label>.md.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A finding lands within a seeded bug's blast radius if it cites the same file within LINE_WINDOW
// lines either side — reviewers routinely anchor on the enclosing statement/declaration rather
// than the exact seeded line.
export const LINE_WINDOW = 3;

// Per-class keyword fingerprint: confirms a finding actually names the planted defect, not just
// any finding that happens to land on the same file+line (e.g. a style nit on the buggy line
// must not count as a catch). Matched case-insensitively against title+evidence+fix. A class with
// no entry here always matches on file+line alone, so a new seeded-bug class needs no code change.
export const CLASS_KEYWORDS = {
  'null-path': ['null', 'undefined', 'nullable', 'optional chain', 'nil'],
  'off-by-one': ['off-by-one', 'off by one', 'boundary', 'inclusive', 'exclusive', 'index'],
  race: ['race', 'concurren', 'lock', 'atomic', 'interleav', 'in-flight'],
  'sql-injection': ['sql injection', 'parameteriz', 'sanitiz', 'escape', 'injection'],
  'missing-authz': ['authoriz', 'access control', 'permission', 'ownership', 'admin', 'authz'],
  'n-plus-one': ['n+1', 'n + 1', 'batch', 'query per', 'loop'],
  'breaking-api-change': ['breaking change', 'backwards', 'backward', 'contract', 'signature', 'compat'],
  'secret-in-log': ['secret', 'password', 'api key', 'apikey', 'credential', 'log'],
  'missing-migration-reversal': ['down()', 'rollback', 'revers', 'migration'],
};

export function classMatches(cls, finding) {
  const keywords = CLASS_KEYWORDS[cls];
  if (!keywords) return true; // unknown class: fall back to file+line only
  const haystack = `${finding.title ?? ''} ${finding.evidence ?? ''} ${finding.fix ?? ''}`.toLowerCase();
  return keywords.some((k) => haystack.includes(k));
}

export function findingMatchesSeed(finding, seed, window = LINE_WINDOW) {
  if (!finding || !seed) return false;
  if (finding.file !== seed.file) return false;
  if (Math.abs((finding.line ?? -Infinity) - seed.line) > window) return false;
  return classMatches(seed.class, finding);
}

// Which findings hit which seeded bugs. A seed can be caught by more than one finding
// (duplicates count once for recall); a finding may match any number of compatible seeds.
export function matchSeeded(findings = [], seeded = [], window = LINE_WINDOW) {
  const matchedSeedIdx = new Set();
  const matchedFindingIdx = new Set();
  seeded.forEach((seed, si) => {
    findings.forEach((f, fi) => {
      if (findingMatchesSeed(f, seed, window)) { matchedSeedIdx.add(si); matchedFindingIdx.add(fi); }
    });
  });
  return { matchedSeedIdx, matchedFindingIdx };
}

// recall = fraction of seeded bugs caught by >=1 finding; precision = fraction of findings that
// correspond to a seeded bug. null (not 0) when the denominator is 0 — a clean case has no recall
// to speak of, and a no-findings run has no precision to speak of; either would misleadingly
// render as 0% otherwise.
export function scoreRecallPrecision(findings = [], seeded = [], window = LINE_WINDOW) {
  const { matchedSeedIdx, matchedFindingIdx } = matchSeeded(findings, seeded, window);
  return {
    recall: seeded.length ? matchedSeedIdx.size / seeded.length : null,
    precision: findings.length ? matchedFindingIdx.size / findings.length : null,
    truePositives: matchedSeedIdx.size,
    falseNegatives: seeded.length - matchedSeedIdx.size,
    falsePositives: findings.length - matchedFindingIdx.size,
    totalSeeded: seeded.length,
    totalFindings: findings.length,
  };
}

// Verify-pass value: of the findings the verify layer DROPPED, how many were noise (no seeded bug
// behind them — a genuine false positive killed) vs. how many were actually a real seeded bug the
// verifier wrongly refuted (a false negative it introduced). `value` nets the two at equal
// weight — a verify layer that trades one real catch for one false alarm killed earns nothing.
export function scoreVerifyPass(dropped = [], seeded = [], window = LINE_WINDOW) {
  const { matchedSeedIdx } = matchSeeded(dropped, seeded, window);
  const wronglyDropped = matchedSeedIdx.size;
  const fpsKilled = dropped.length - wronglyDropped;
  return { fpsKilled, wronglyDropped, totalDropped: dropped.length, value: fpsKilled - wronglyDropped };
}

// One case's full scorecard. `result` is what run.mjs recorded for this case:
// { findings, dropped, skipped, reason }. A skipped (model-gated) case carries no signal — score
// it as null throughout rather than 0, so an environment that simply couldn't run the model
// doesn't drag the aggregate down as if it had failed every bug.
export function scoreCase(caseDef, result = {}) {
  if (result.skipped) {
    return { name: caseDef.name, skipped: true, reason: result.reason ?? 'skipped', recall: null, precision: null, verifyPass: null };
  }
  const seeded = caseDef.seeded ?? [];
  const findings = result.findings ?? [];
  const rp = scoreRecallPrecision(findings, seeded);
  const verifyPass = scoreVerifyPass(result.dropped ?? [], seeded);
  return { name: caseDef.name, skipped: false, ...rp, verifyPass };
}

// Aggregate across every non-skipped case — a macro-average, so a case with more seeded bugs
// doesn't dominate the headline number over one with fewer.
export function aggregate(caseScores = []) {
  const scored = caseScores.filter((c) => !c.skipped);
  const withRecall = scored.filter((c) => c.recall != null);
  const withPrecision = scored.filter((c) => c.precision != null);
  const avg = (xs, f) => (xs.length ? xs.reduce((s, c) => s + f(c), 0) / xs.length : null);
  return {
    totalCases: caseScores.length,
    scoredCases: scored.length,
    skippedCases: caseScores.length - scored.length,
    meanRecall: avg(withRecall, (c) => c.recall),
    meanPrecision: avg(withPrecision, (c) => c.precision),
    totalFpsKilled: scored.reduce((s, c) => s + (c.verifyPass?.fpsKilled ?? 0), 0),
    totalWronglyDropped: scored.reduce((s, c) => s + (c.verifyPass?.wronglyDropped ?? 0), 0),
  };
}

// Score a full run. `label` names the run (an ISO date, a git sha, a prompt-version tag — the
// CALLER decides; never Date.now() in here) so re-scoring recorded run data is byte-identical
// and a scoreboard file ties back to the prompt/commit that produced it.
export function scoreRun(label, cases, results) {
  const byName = new Map((results ?? []).map((r) => [r.name, r]));
  const caseScores = cases.map((c) => scoreCase(c, byName.get(c.name) ?? { skipped: true, reason: 'no result recorded for this case' }));
  return { label, cases: caseScores, aggregate: aggregate(caseScores) };
}

// Markdown scoreboard — one row per case plus the aggregate header.
export function renderScoreboard(label, caseScores, agg) {
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const lines = [
    `# Eval scoreboard — ${label}`,
    '',
    `Cases: ${agg.totalCases} (${agg.scoredCases} scored, ${agg.skippedCases} skipped/model-gated)`,
    `Mean recall: ${pct(agg.meanRecall)} · Mean precision: ${pct(agg.meanPrecision)}`,
    `Verify-pass: ${agg.totalFpsKilled} FP(s) killed, ${agg.totalWronglyDropped} true finding(s) wrongly dropped`,
    '',
    '| Case | Status | Recall | Precision | FPs killed | Wrongly dropped |',
    '|---|---|---|---|---|---|',
  ];
  for (const c of caseScores) {
    lines.push(c.skipped
      ? `| ${c.name} | skipped (${c.reason}) | — | — | — | — |`
      : `| ${c.name} | scored | ${pct(c.recall)} | ${pct(c.precision)} | ${c.verifyPass.fpsKilled} | ${c.verifyPass.wronglyDropped} |`);
  }
  return lines.join('\n') + '\n';
}

// Writes both artifacts for a scored run. Returns the two paths written.
export function writeScoreboard(outDir, scored) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${scored.label}.json`);
  const mdPath = join(outDir, `${scored.label}.md`);
  writeFileSync(jsonPath, JSON.stringify(scored, null, 2) + '\n');
  writeFileSync(mdPath, renderScoreboard(scored.label, scored.cases, scored.aggregate));
  return { jsonPath, mdPath };
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const label = arg('--label');
  if (!label) { process.stderr.write('score.mjs: --label <label> is required\n'); process.exit(2); }
  const inPath = arg('--in');
  const outDir = arg('--out-dir', join(new URL('.', import.meta.url).pathname, 'results'));
  const raw = inPath ? readFileSync(inPath, 'utf8')
    : await new Promise((r) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => r(b)); });
  const data = JSON.parse(raw || '{}');
  const scored = scoreRun(label, data.cases ?? [], data.results ?? []);
  writeScoreboard(outDir, scored);
  process.stdout.write(JSON.stringify(scored, null, 2) + '\n');
}
