#!/usr/bin/env node
// CLI: render findings into REVIEW.md + REVIEW.html + a terminal summary + a verdict.
// Reads a JSON object from stdin:
//   { findings, criteria, tier, gate, needsHuman, skipped, strengths, summary,
//     context, verify, learnings, learningStore, range }
// Usage: ... | node report.mjs [--gate] [--out REVIEW.md] [--html REVIEW.html]
// With --gate, exits with the verdict's exit code (1 on BLOCK).
import { writeFileSync } from 'node:fs';
import { renderReport, renderVerdict, renderHtml, agentCoverage } from './render.mjs';
import { loadLearnings, saveLearnings, recordRun, applyLearnings } from './memory.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const gateMode = process.argv.includes('--gate');
const outPath = arg('--out', 'REVIEW.md');
const htmlPath = arg('--html', 'REVIEW.html');

const input = await new Promise((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (buf += d));
  process.stdin.on('end', () => resolve(buf));
});

let data;
try {
  data = JSON.parse(input || '{}');
} catch {
  console.error('report.mjs: stdin was not valid JSON');
  process.exit(2);
}

let findings = data.findings ?? [];
const criteria = data.criteria ?? [];
const tier = data.tier ?? 'standard';
const gate = data.gate ?? { block_on: ['critical'], warn_on: ['high'] };
const needsHuman = data.needsHuman ?? [];
const skipped = data.skipped ?? [];
const strengths = data.strengths ?? [];
const summary = data.summary ?? '';
const context = data.context ?? {};
const verify = data.verify ?? {};

// Agent run-down: who ran, who didn't, and why. Derived from the deterministic plan
// (data.plan, the plan.mjs output) plus the orchestrator's observed dispatch counts
// (data.agentRuns: agentName → times dispatched). Omitted when no plan is supplied.
const coverage = data.plan
  ? agentCoverage({ ...data.plan, commentMode: data.commentMode ?? data.plan.commentMode }, data.agentRuns ?? {})
  : null;

// fold in per-project memory (suppress accepted false-positives, tag recurring)
let learningNote = '';
const store = data.learningStore;
if (store) {
  const learnings = loadLearnings(store);
  const { kept, suppressed } = applyLearnings(findings, learnings);
  findings = kept;
  if (suppressed.length) learningNote = `${suppressed.length} known false-positive(s) suppressed from memory`;
}

const md = renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, context, verify, coverage, learnings: { applied: learningNote } });
writeFileSync(outPath, md);

const html = renderHtml({ findings, criteria, tier, gate, needsHuman, skipped, strengths, summary, context, verify, coverage });
writeFileSync(htmlPath, html);

// persist this run into memory
if (store) {
  const reported = findings.filter((f) => (f.confidence ?? 100) >= 80);
  saveLearnings(store, recordRun(loadLearnings(store), { reported, needsHuman, range: data.range }));
}

const verdict = renderVerdict(findings, gate);
const kept = findings.filter((f) => (f.confidence ?? 100) >= 80);
const bySev = kept.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
const counts = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', ') || 'no findings';

console.log(`Code review (tier: ${tier}) → ${outPath}, ${htmlPath}`);
console.log(`Findings: ${counts}`);
if (needsHuman.length) console.log(`ACTION: ${needsHuman.length} item(s) need your input (see "Needs your input").`);
if (learningNote) console.log(learningNote);
console.log(`Verdict: ${verdict.verdict}`);

process.exit(gateMode ? verdict.exitCode : 0);
