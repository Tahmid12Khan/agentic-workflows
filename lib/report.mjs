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
//     context, verify, learningStore, range, startedAt, prNumber, plan, agentRuns, checkout,
//     testSignal, postedCommentsPath, contextPackStats }
// postedCommentsPath (WS3, optional, defaults to feedback.mjs's DEFAULT_STORE) is read to attach a
// best-effort commentId per finding into last-review.json, for a later run's thread-resolution.
// Always writes into a per-run folder:
//   .adversarial-code-review/review-{YYYY-MM-DD}/review-{counter}[-pr-{n}]/review.{md,html}
// With --gate, the CLI exits with the verdict's exit code (1 on BLOCK). --base-dir relocates
// the parent of the per-run folder. There is no --out/--html: the folder + filenames are fixed
// so a review cannot be written to the wrong place.
import { writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport, renderVerdict, renderHtml, agentCoverage, partitionOutOfDiff } from './render.mjs';
import { loadLearnings, saveLearnings, recordRun, applyLearnings, dedupAgainstPrevious, loadLastReview, buildLastReview, saveLastReview, findingKey } from './memory.mjs';
import { computeReviewUsage } from './usage.mjs';
import { diffFindings, nextRound, nitConvergence } from './rereview.mjs';
import { capNits } from './comments.mjs';
import { loadPostedComments, DEFAULT_STORE } from './feedback.mjs';

// WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the new
// name; fall back to the old one only if it's the ONLY one present — supports un-migrated installs
// for one release cycle.
function defaultAcrDir() {
  return (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
    ? '.adverserial-code-review'
    : '.adversarial-code-review';
}

// Same optional-config convention as plan.mjs/test-signal.mjs/comments.mjs: read once, default {},
// never throw. Only `rereview.nit_rounds` and `report.max_posted_nits` are consumed here — both
// additive/informational (WS3): they drive the "report-only nit" / nit-cap notes on the report,
// mirroring (approximately — this run has no `existingComments` to dedupe against first) the
// selection comments.mjs actually posts with.
function readConfig() {
  try { return JSON.parse(readFileSync(`${defaultAcrDir()}/config.json`, 'utf8')); } catch { return {}; }
}

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
export async function generateReport(data = {}, { gateMode = false, baseDir = defaultAcrDir() } = {}) {
  const notes = [];
  if (!data.plan) return { ok: false, missing: 'plan', folderPath: null, verdict: 'ERROR', exitCode: 2, lines: [], notes };
  if (!data.agentRuns) return { ok: false, missing: 'agentRuns', folderPath: null, verdict: 'ERROR', exitCode: 2, lines: [], notes };

  let findings = data.findings ?? [];
  const outOfDiff = data.outOfDiff ?? [];        // advisory-only, anchored outside the change
  const criteria = data.criteria ?? [];
  const tier = data.tier ?? 'standard';
  const gate = data.gate ?? { block_on: ['critical'], warn_on: ['important'] };
  // WS4 (effort): 'low' means fewer, higher-confidence findings — anything the verifier couldn't
  // confirm (needs-human, incl. real-but-below-the-raised-report-bar) is DROPPED, never surfaced.
  // 'medium'/'high'/'max' are unaffected (identity / broadened, not narrowed).
  const effort = data.plan?.effort ?? null;
  const reportThreshold = data.plan?.verify?.reportConfidence ?? null;
  const needsHuman = effort === 'low' ? [] : (data.needsHuman ?? []);
  const skipped = data.skipped ?? [];
  const strengths = data.strengths ?? [];
  const summary = data.summary ?? '';
  const summaryPoints = data.summaryPoints ?? [];
  const context = data.context ?? {};
  const verify = data.verify ?? {};
  const checkout = data.checkout ?? null;
  const testSignal = data.testSignal ?? null;   // S6.4: executed-test signal for the report header
  const contextPackStats = data.contextPackStats ?? null;   // WS7 S3: context-pack.mjs's size/per-section counts, for the coverage section
  const processAdvisories = data.plan?.processAdvisories ?? [];   // WS1: deterministic change-shape advisories (advisory only)
  const filesCapped = data.plan?.filesCapped ?? null;   // set when the change exceeded max_review_files → report WARNs that some files went unreviewed
  const filesFunneled = data.plan?.filesFunneled ?? null;   // set when the change exceeded mega_pr.threshold (#10) → report WARNs which mechanical clusters were sampled

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

  // Token usage + USD cost of this run, summed from the session transcripts within
  // the review's time window. Best-effort: degrades to a note (and no panel) when
  // transcripts aren't reachable — never fails the report.
  let usage = null;
  try {
    usage = computeReviewUsage({ since: startValid ? startedAt.toISOString() : null });
  } catch (e) { notes.push(`usage tally skipped: ${e.message}`); }

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

  // Incremental review (S9) + WS3 re-review convergence both key off the SAME previous-run
  // state — last-review.json, read here BEFORE we overwrite it below with this run's own state.
  // Best-effort — a missing/corrupt file just means "no prior run" for both features.
  const incremental = data.incremental === true;
  const lastReviewPath = join(baseDir, 'last-review.json');
  let prevReview = null;
  try { prevReview = loadLastReview(lastReviewPath); } catch (e) { notes.push(`last-review load skipped: ${e.message}`); }
  if (incremental && prevReview) findings = dedupAgainstPrevious(findings, prevReview.findings ?? []);

  // WS3: classify against the previous run's findings — unconditional (not gated on
  // --incremental): a plain re-review of the same PR converges even when the caller didn't ask to
  // narrow the diff. `resolved` findings are NOT this report's concern (they've already vanished
  // from `findings`) — comments.mjs (which has gh + the prevHead..head diff) does the actual
  // reply/resolve-thread work; this report only tags `persisting` ("Still open") and computes the
  // round, so it can note which fresh nits the convergence/nit-cap policy would hold back from
  // posting (informational only — every finding still appears in the report regardless).
  const wsConfig = readConfig();
  const nitRounds = Number(wsConfig.rereview?.nit_rounds ?? 1);
  const maxPostedNits = Number(wsConfig.report?.max_posted_nits ?? 5);
  const round = nextRound(prevReview, { base: data.plan?.base ?? null, prNumber });
  const { persisting, new: freshFindings } = diffFindings(prevReview?.findings ?? [], findings);
  const persistingKeys = new Set(persisting.map(findingKey));
  const freshEligible = freshFindings.filter((f) => (f.confidence ?? 100) >= 80);
  const { reportOnly } = nitConvergence(freshEligible, round, nitRounds);
  const reportOnlyKeys = new Set(reportOnly.map(findingKey));
  const { dropped: cappedNits } = capNits(freshEligible.filter((f) => !reportOnlyKeys.has(findingKey(f))), maxPostedNits);
  const cappedKeys = new Set(cappedNits.map(findingKey));
  findings = findings.map((f) => {
    const k = findingKey(f);
    if (persistingKeys.has(k)) return { ...f, persisting: true };
    if (reportOnlyKeys.has(k)) return { ...f, notPostable: 'convergence' };
    if (cappedKeys.has(k)) return { ...f, notPostable: 'nit-cap' };
    return f;
  });

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
    const md = renderReport({ findings, criteria, tier, gate, needsHuman, skipped, strengths, summary, summaryPoints, context, verify, coverage, meta, checkout, usage, outOfDiff, testSignal, processAdvisories, learnings: { applied: learningNote }, effort, reportThreshold, round, nitRounds, contextPackStats, filesCapped, filesFunneled });
    writeFileSync(join(outDir, 'review.md'), md);
    const html = renderHtml({ findings, criteria, tier, gate, needsHuman, skipped, strengths, summary, summaryPoints, context, verify, coverage, meta, checkout, usage, outOfDiff, testSignal, processAdvisories, effort, reportThreshold, round, nitRounds, contextPackStats, filesCapped, filesFunneled });
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

  // Persist this run's incremental state — script-written last-review.json, sha-keyed on the reviewed
  // base/head (S9). Written on EVERY review (not just --incremental) so the first --incremental run has
  // a prior head to narrow from. Best-effort; only when we have a head sha to key on.
  // WS3: also carries the round counter + a best-effort commentId per finding, resolved from
  // posted-comments.json (`--comment` runs BEFORE this script in the review.md pipeline, so by now
  // it already reflects anything posted this run).
  if (data.plan?.head) {
    try {
      mkdirSync(baseDir, { recursive: true });
      let commentIdByKey = null;
      try {
        const posted = loadPostedComments(data.postedCommentsPath ?? DEFAULT_STORE);
        const comments = prNumber != null ? (posted.prs?.[String(prNumber)]?.comments ?? []) : [];
        if (comments.length) commentIdByKey = new Map(comments.map((c) => [c.key, c.id]));
      } catch { /* commentId stays unattached — the next run's thread-resolution falls back to posted-comments.json directly */ }
      // Persist ONLY the postable (conf>=80, gate-affecting) set — never the [reportThreshold,80)
      // "Uncertain" findings surfaced at --effort high/max nor the nit-capped ones. Otherwise the
      // next run's diffFindings would class a never-posted finding as "persisting" and suppress its
      // FIRST-ever comment (it keys on last-review, while thread-resolution keys on the actual posted
      // set — the two must agree on "was this ever posted?"). Integration-review WS3×WS4 fix.
      const postable = findings.filter((f) => (f.confidence ?? 100) >= 80);
      saveLastReview(lastReviewPath, buildLastReview({ base: data.plan.base, head: data.plan.head, range: data.range ?? data.plan.range ?? null, findings: postable, round, prNumber, commentIdByKey }));
    } catch (e) { notes.push(`incremental state save skipped: ${e.message}`); }
  }

  const vd = renderVerdict(findings, gate, tier);
  const kept = findings.filter((f) => (f.confidence ?? 100) >= 80);
  const bySev = kept.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const counts = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', ') || 'no findings';

  // WS6: machine-readable severity tally for CI. Counts the GATE-AFFECTING (in-diff, conf>=80)
  // findings by severity — exactly the set renderVerdict scores — plus `preExisting`, the count of
  // pre-existing bugs surfaced from the out-of-diff set (advisory, never gated). Emitted two ways:
  // a final `acr-severity: {...}` stdout line (jq-friendly for CI) and verdict.json in the run folder.
  const severityTally = {
    critical: bySev.critical ?? 0,
    important: bySev.important ?? 0,
    minor: bySev.minor ?? 0,
    suggestion: bySev.suggestion ?? 0,
    preExisting: partitionOutOfDiff(outOfDiff).preExisting.length,
    verdict: vd.verdict,
  };
  if (folderPath) {
    try { writeFileSync(join(folderPath, 'verdict.json'), JSON.stringify(severityTally, null, 2) + '\n'); }
    catch (e) { notes.push(`verdict.json write skipped: ${e.message}`); }
  }

  const lines = [
    `Code review (tier: ${tier})${prNumber ? ` · PR #${prNumber}` : ''} → ${folderPath ?? '(not written)'}`,
    `Findings: ${counts}`,
  ];
  if (needsHuman.length) lines.push(`ACTION: ${needsHuman.length} item(s) need your input (see "Needs your input").`);
  if (learningNote) lines.push(learningNote);
  lines.push(`Verdict: ${vd.verdict}`);
  lines.push(`acr-severity: ${JSON.stringify(severityTally)}`);   // machine-readable, always last

  return { ok: true, folderPath, verdict: vd.verdict, exitCode: gateMode ? vd.exitCode : 0, lines, notes, severityTally };
}

// --- thin CLI: read stdin, render, print the summary, exit with the gate code ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const gateMode = process.argv.includes('--gate');
  const baseDir = arg('--base-dir', defaultAcrDir());

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
