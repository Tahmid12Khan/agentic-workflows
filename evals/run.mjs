#!/usr/bin/env node
// CLI: eval harness runner — the regression gate for prompt/doctrine changes (see evals/README.md).
//
// For every evals/cases/<name>.json this builds a throwaway 2-commit git repo from the case's
// fixture files (never touches the real project repo) and runs the DETERMINISTIC layers of the
// pipeline for real — ../lib/plan.mjs and ../lib/capture-diff.mjs — against it, so a change that
// breaks tiering/diff-capture on these fixtures is caught here, not just in unit tests.
//
// The model-gated layer (the actual dimension review that produces findings to score) is only
// ever attempted when explicitly opted in (ACR_EVAL_LIVE=1) AND the `claude` CLI resolves; every
// child process is timeout-bounded. Otherwise — the default, and the only path exercised in CI —
// each case is marked skipped and this script still completes normally: model access is never
// assumed, so `node evals/run.mjs` always exits 0 offline.
//
// Usage: node run.mjs [--label <label>] [--cases-dir <dir>] [--out-dir <dir>]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scoreRun, writeScoreboard } from './score.mjs';

const EVALS_DIR = new URL('.', import.meta.url).pathname;
const LIB_DIR = new URL('../lib', import.meta.url).pathname;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function have(cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'pipe', timeout: 5000 }); return true; }
  catch { return false; }
}

export function loadCases(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

// Build a throwaway git repo for one case: commit 1 is an empty base (these are all new files —
// there is no "before" state); commit 2 adds every seeded-bug file AND every cleanFile together,
// so BOTH land in the reviewed diff. cleanFiles must be diffed, not just present, to mean
// anything — they exist to check that a reviewer doesn't cry wolf on unrelated clean code sitting
// in the same change; sitting them in the base commit (out of diff) would make that untestable.
export function buildFixtureRepo(caseDef, evalsDir = EVALS_DIR) {
  const srcDir = join(evalsDir, caseDef.dir);
  const repoDir = mkdtempSync(join(tmpdir(), 'acr-eval-'));
  const git = (args) => execFileSync('git', args, { cwd: repoDir, stdio: 'pipe', timeout: 15000 });
  const copyIn = (rel) => {
    const dest = join(repoDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(join(srcDir, rel), 'utf8'));
  };

  git(['init', '-q']);
  git(['config', 'user.email', 'eval@example.com']);
  git(['config', 'user.name', 'acr-eval']);
  git(['commit', '-q', '-m', 'base', '--allow-empty']);
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, timeout: 15000 }).toString().trim();

  const changedFiles = new Set([...(caseDef.seeded ?? []).map((s) => s.file), ...(caseDef.cleanFiles ?? [])]);
  for (const rel of changedFiles) copyIn(rel);
  if (changedFiles.size) { git(['add', '-A']); git(['commit', '-q', '-m', 'change under review']); }

  return { repoDir, base };
}

// Run the deterministic layers for real, against the throwaway repo. Advisory: any failure here
// degrades to a note rather than aborting the case (golden rule: degrade, never crash mid-run).
export function runDeterministic(repoDir, base, libDir = LIB_DIR) {
  const notes = [];
  let plan = null;
  try {
    const out = execFileSync(process.execPath, [join(libDir, 'plan.mjs'), '--base', base],
      { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    plan = JSON.parse(out.toString());
  } catch (e) { notes.push(`plan.mjs failed: ${e.message}`); }

  let diffCaptured = false;
  try {
    const out = execFileSync(process.execPath, [join(libDir, 'capture-diff.mjs'), '--base', base],
      { cwd: repoDir, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    diffCaptured = out.toString().includes('diff --git');
  } catch (e) { notes.push(`capture-diff.mjs failed: ${e.message}`); }

  return { tier: plan?.tier ?? null, dimensions: plan?.dimensions ?? [], diffCaptured, notes };
}

// Best-effort model-gated pass. Off by default (ACR_EVAL_LIVE unset) so the harness never spends
// money/time or risks hanging in an unattended run; when opted in, every step is timeout-bounded
// so a stuck/unauthenticated CLI degrades to the same "skipped" shape as no model at all — never
// a crash, never a hang.
export function runModelGated(caseDef, srcDir) {
  if (process.env.ACR_EVAL_LIVE !== '1') {
    return { skipped: true, reason: 'model-gated: set ACR_EVAL_LIVE=1 to attempt a live claude -p run', findings: [], dropped: [] };
  }
  if (!have('claude')) {
    return { skipped: true, reason: 'model-gated: claude CLI not found on PATH', findings: [], dropped: [] };
  }
  try {
    const files = [...new Set([...(caseDef.seeded ?? []).map((s) => s.file), ...(caseDef.cleanFiles ?? [])])];
    const sources = files.map((f) => `--- ${f} ---\n${readFileSync(join(srcDir, f), 'utf8')}`).join('\n\n');
    const prompt = `Review the following source file(s) for bugs. Reply with ONLY a JSON array of findings, each `
      + `{"file":"<relative path>","line":<number>,"severity":"critical|important|minor|suggestion",`
      + `"title":"","evidence":"","fix":""}. No prose, no markdown fences.\n\n${sources}`;
    const out = execFileSync('claude', ['-p', prompt], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const findings = JSON.parse(out.toString().trim());
    return { skipped: false, findings: Array.isArray(findings) ? findings : [], dropped: [] };
  } catch (e) {
    return { skipped: true, reason: `model-gated: live run failed (${e.message})`, findings: [], dropped: [] };
  }
}

function runCase(caseDef) {
  const { repoDir, base } = buildFixtureRepo(caseDef);
  try {
    const deterministic = runDeterministic(repoDir, base);
    const modelResult = runModelGated(caseDef, join(EVALS_DIR, caseDef.dir));
    return { name: caseDef.name, deterministic, ...modelResult };
  } finally {
    try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const casesDir = arg('--cases-dir', join(EVALS_DIR, 'cases'));
  const outDir = arg('--out-dir', join(EVALS_DIR, 'results'));
  // Label is a run tag, not a finding identity — Date() here is fine (see CLAUDE.md determinism
  // rule); score.mjs itself never touches Date, it only receives this as a parameter.
  const label = arg('--label', new Date().toISOString().slice(0, 10));

  const cases = loadCases(casesDir);
  const results = cases.map(runCase);
  const scored = scoreRun(label, cases, results);
  const { jsonPath, mdPath } = writeScoreboard(outDir, scored);

  const skipped = results.filter((r) => r.skipped).length;
  process.stdout.write(
    `evals: ${cases.length} case(s), ${cases.length - skipped} scored, ${skipped} skipped (model-gated)\n`
    + `mean recall ${scored.aggregate.meanRecall == null ? 'n/a' : Math.round(scored.aggregate.meanRecall * 100) + '%'}, `
    + `mean precision ${scored.aggregate.meanPrecision == null ? 'n/a' : Math.round(scored.aggregate.meanPrecision * 100) + '%'}\n`
    + `wrote ${jsonPath}\nwrote ${mdPath}\n`
  );
}
