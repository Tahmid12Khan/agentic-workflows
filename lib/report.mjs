#!/usr/bin/env node
// CLI + library: render findings into review.md + review.html + a terminal summary + a verdict.
//
// generateReport(data, opts) does the work and RETURNS { folderPath, verdict, exitCode, lines,
// notes } — it NEVER process.exits and degrades every optional step (memory, file write) to a
// note, so the caller can't be crashed by a soft failure. /review step 5 runs this file directly
// via node after the Workflow returns (the Workflow no longer spawns a report executor agent).
//
// Reads a JSON object from stdin:
//   { findings, criteria, tier, gate, needsHuman, skipped, strengths, summary,
//     context, verify, learningStore, range, startedAt, prNumber, plan, agentRuns, worktrees }
// Always writes into a per-run folder:
//   .adverserial-code-review/review-{YYYY-MM-DD}/review-{counter}[-pr-{n}]/review.{md,html}
// With --gate, the CLI exits with the verdict's exit code (1 on BLOCK). --base-dir relocates
// the parent of the per-run folder. There is no --out/--html: the folder + filenames are fixed
// so a review cannot be written to the wrong place.
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport, renderVerdict, renderHtml, agentCoverage } from './render.mjs';
import { loadLearnings, saveLearnings, recordRun, applyLearnings } from './memory.mjs';

// counter is per-day, inside the date folder
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

function humanDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Render + write a review and return its result. Pure of process state: required-input violations
// come back as { ok:false, missing } (the CLI maps them to exit 2 — the same hard refusal as
// before); optional-step failures (memory, file write) are pushed onto `notes` and the run
// continues. Golden rule: degrade to a skip note, never crash mid-run.
export async function generateReport(data = {}, { gateMode = false, baseDir = '.adverserial-code-review' } = {}) {
  const notes = [];
  if (!data.plan) return { ok: false, missing: 'plan', folderPath: null, verdict: 'ERROR', exitCode: 2, lines: [], notes };
  if (!data.agentRuns) return { ok: false, missing: 'agentRuns', folderPath: null, verdict: 'ERROR', exitCode: 2, lines: [], notes };

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

  // Agent run-down: who ran, who didn't, and why. Derived from the deterministic plan plus the
  // orchestrator's observed dispatch counts (data.agentRuns: agentName → times dispatched).
  const coverage = agentCoverage({ ...data.plan, commentMode: data.commentMode ?? data.plan.commentMode }, data.agentRuns ?? {});

  // --- timing + PR for the report header ---
  const finishedAt = new Date();
  const startedAt = data.startedAt ? new Date(data.startedAt) : null;
  const startValid = startedAt && !Number.isNaN(startedAt.getTime());
  const prNumber = data.prNumber ?? data.context?.pr?.number ?? null;
  const humanTime = (d) => d.toUTCString();                    // unambiguous, human-readable
  const meta = {
    prNumber,
    started: startValid ? humanTime(startedAt) : null,
    finished: humanTime(finishedAt),
    duration: startValid ? humanDuration(finishedAt - startedAt) : null,
  };

  // fold in per-project memory (suppress accepted false-positives, tag recurring) — best-effort
  let learningNote = '';
  const store = data.learningStore;
  if (store) {
    try {
      const learnings = loadLearnings(store);
      const { kept, suppressed } = applyLearnings(findings, learnings);
      findings = kept;
      if (suppressed.length) learningNote = `${suppressed.length} known false-positive(s) suppressed from memory`;
    } catch (e) { notes.push(`memory load skipped: ${e.message}`); }
  }

  // --- where to write: always a per-run folder under baseDir (best-effort) ---
  let folderPath = null;
  const dateStr = (startValid ? startedAt : finishedAt).toISOString().slice(0, 10);
  const dateDir = join(baseDir, `review-${dateStr}`);
  const prPart = prNumber ? `-pr-${prNumber}` : '';
  try {
    mkdirSync(dateDir, { recursive: true });
    const counter = nextCounter(dateDir);
    const outDir = join(dateDir, `review-${counter}${prPart}`);
    mkdirSync(outDir, { recursive: true });
    const md = renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, context, verify, coverage, meta, worktrees, learnings: { applied: learningNote } });
    writeFileSync(join(outDir, 'review.md'), md);
    const html = renderHtml({ findings, criteria, tier, gate, needsHuman, skipped, strengths, summary, context, verify, coverage, meta, worktrees });
    writeFileSync(join(outDir, 'review.html'), html);
    folderPath = outDir;
  } catch (e) {
    notes.push(`report write failed: ${e.message}`);
  }

  // persist this run into memory — best-effort
  if (store) {
    try {
      const reported = findings.filter((f) => (f.confidence ?? 100) >= 80);
      saveLearnings(store, recordRun(loadLearnings(store), { reported, needsHuman, range: data.range }));
    } catch (e) { notes.push(`memory save skipped: ${e.message}`); }
  }

  const vd = renderVerdict(findings, gate);
  const kept = findings.filter((f) => (f.confidence ?? 100) >= 80);
  const bySev = kept.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const counts = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', ') || 'no findings';

  const lines = [
    `Code review (tier: ${tier})${prNumber ? ` · PR #${prNumber}` : ''} → ${folderPath ?? '(not written)'}`,
    `Findings: ${counts}`,
  ];
  if (needsHuman.length) lines.push(`ACTION: ${needsHuman.length} item(s) need your input (see "Needs your input").`);
  if (learningNote) lines.push(learningNote);
  lines.push(`Verdict: ${vd.verdict}`);

  return { ok: true, folderPath, verdict: vd.verdict, exitCode: gateMode ? vd.exitCode : 0, lines, notes };
}

// --- thin CLI: read stdin, render, print the summary, exit with the gate code ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const gateMode = process.argv.includes('--gate');
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

  const res = await generateReport(data, { gateMode, baseDir });
  if (!res.ok) {
    if (res.missing === 'plan') {
      console.error('report.mjs: "plan" is required (the plan.mjs output) — it drives the Agents & coverage section. Refusing to write a report without it.');
    } else if (res.missing === 'agentRuns') {
      console.error('report.mjs: "agentRuns" is required (agentName → dispatch count). Refusing to write a report without it.');
    } else {
      console.error(`report.mjs: ${res.notes.join('; ') || 'failed to generate report'}`);
    }
    process.exit(2);
  }

  for (const l of res.lines) console.log(l);
  for (const n of res.notes) console.error(n);   // surface soft-degrade notes without failing the run
  process.exit(res.exitCode);
}
