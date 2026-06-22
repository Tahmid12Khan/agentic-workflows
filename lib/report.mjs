#!/usr/bin/env node
// CLI: render findings into review.md + review.html + a terminal summary + a verdict.
// Reads a JSON object from stdin:
//   { findings, criteria, tier, gate, needsHuman, skipped, strengths, summary,
//     context, verify, learnings, learningStore, range, startedAt, prNumber, plan, agentRuns, worktrees }
// By default writes into a per-run folder:
//   .adverserial-code-review/review-{YYYY-MM-DD}/review-{counter}[-pr-{n}]/review.{md,html}
// Pass --out + --html to write to explicit paths instead. With --gate, exits with the
// verdict's exit code (1 on BLOCK).
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport, renderVerdict, renderHtml, agentCoverage } from './render.mjs';
import { loadLearnings, saveLearnings, recordRun, applyLearnings } from './memory.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const gateMode = process.argv.includes('--gate');
const explicitOut = arg('--out', null);
const explicitHtml = arg('--html', null);
const baseDir = arg('--base-dir', '.adverserial-code-review');

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
const worktrees = data.worktrees ?? [];

// Agent run-down: who ran, who didn't, and why. Derived from the deterministic plan
// (data.plan, the plan.mjs output) plus the orchestrator's observed dispatch counts
// (data.agentRuns: agentName → times dispatched). Omitted when no plan is supplied.
const coverage = data.plan
  ? agentCoverage({ ...data.plan, commentMode: data.commentMode ?? data.plan.commentMode }, data.agentRuns ?? {})
  : null;

// --- timing + PR for the report header ---
const finishedAt = new Date();
const startedAt = data.startedAt ? new Date(data.startedAt) : null;
const startValid = startedAt && !Number.isNaN(startedAt.getTime());
const prNumber = data.prNumber ?? data.context?.pr?.number ?? null;
const humanTime = (d) => d.toUTCString();                    // unambiguous, human-readable
function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
const meta = {
  prNumber,
  started: startValid ? humanTime(startedAt) : null,
  finished: humanTime(finishedAt),
  duration: startValid ? humanDuration(finishedAt - startedAt) : null,
};

// --- where to write: explicit --out/--html override, else a per-run folder ---
function nextCounter(dir) {
  let max = 0;
  try {
    for (const name of readdirSync(dir)) {
      const m = /^review-(\d+)\b/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch { /* dir does not exist yet */ }
  return max + 1;
}
let outPath, htmlPath, outDir = null;
if (explicitOut && explicitHtml) {
  outPath = explicitOut;
  htmlPath = explicitHtml;
} else {
  // .adverserial-code-review/review-{YYYY-MM-DD}/review-{counter}[-pr-{n}]/review.{md,html}
  const dateStr = (startValid ? startedAt : finishedAt).toISOString().slice(0, 10);
  const dateDir = join(baseDir, `review-${dateStr}`);
  mkdirSync(dateDir, { recursive: true });
  const counter = nextCounter(dateDir);              // counter is per-day, inside the date folder
  const prPart = prNumber ? `-pr-${prNumber}` : '';
  outDir = join(dateDir, `review-${counter}${prPart}`);
  mkdirSync(outDir, { recursive: true });
  outPath = join(outDir, 'review.md');
  htmlPath = join(outDir, 'review.html');
}

// fold in per-project memory (suppress accepted false-positives, tag recurring)
let learningNote = '';
const store = data.learningStore;
if (store) {
  const learnings = loadLearnings(store);
  const { kept, suppressed } = applyLearnings(findings, learnings);
  findings = kept;
  if (suppressed.length) learningNote = `${suppressed.length} known false-positive(s) suppressed from memory`;
}

const md = renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, context, verify, coverage, meta, worktrees, learnings: { applied: learningNote } });
writeFileSync(outPath, md);

const html = renderHtml({ findings, criteria, tier, gate, needsHuman, skipped, strengths, summary, context, verify, coverage, meta, worktrees });
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

console.log(`Code review (tier: ${tier})${prNumber ? ` · PR #${prNumber}` : ''} → ${outDir ?? `${outPath}, ${htmlPath}`}`);
console.log(`Findings: ${counts}`);
if (needsHuman.length) console.log(`ACTION: ${needsHuman.length} item(s) need your input (see "Needs your input").`);
if (learningNote) console.log(learningNote);
console.log(`Verdict: ${verdict.verdict}`);

process.exit(gateMode ? verdict.exitCode : 0);
