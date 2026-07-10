#!/usr/bin/env node
// CLI + library: the author-side loop (`/review-respond`). Locates the latest review report,
// parses its findings back out of review.md (report.mjs never persists a raw findings JSON —
// review.md is the only durable record), and hosts the PURE fix-application planner that the
// finding-responder agent drives one edit at a time via Bash. Advisory by default; --fix is the
// SINGLE sanctioned code-mutating path in the plugin, gated by one explicit confirmation, a
// dirty-tree/detached-HEAD scope guard, and a revert-on-test-regression safety net.
//
// Usage (subcommands, one JSON object on stdout each):
//   validate (stdin: { responses } or a bare responses array)
//                                                  → { valid, errors, warnings }; exit 1 if invalid
//   find   [--report <path>] [--dir <baseDir>]   → { folderPath, findings, notes }
//   scope  [--fix]                                → { dirty, detachedHead, blocked, reason }
//   apply  (stdin: { id, stance, edit:{file,oldString,newString}, confirmed })
//                                                  → one applyOneFix result; runs tests.command
//                                                    (config, never guessed) after the write and
//                                                    reverts on regression
//   record (stdin: { responses, findings })       → { recorded, store } — folds `disagree`
//                                                    stances into learnings.json as FP candidates
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { loadLearnings, saveLearnings, recordRun } from './memory.mjs';

const DEFAULT_TIMEOUT_MS = 600000; // same ceiling as test-signal.mjs

// WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the new
// name; fall back to the old one only if it's the ONLY one present — supports un-migrated installs
// for one release cycle.
function defaultAcrDir() {
  return (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
    ? '.adverserial-code-review'
    : '.adversarial-code-review';
}

// --- locate the report folder (pure over an injected reader would be nicer, but readdirSync on
// a fixed, script-owned directory tree is the same shape every other module uses — checkout.mjs,
// report.mjs — so we keep the fs calls inline and keep the SORT/SELECT logic the part worth
// unit-testing via a real tmp-dir fixture in tests/respond.test.mjs) ---
export function findLatestReportFolder(baseDir = defaultAcrDir()) {
  let dateDirs;
  try {
    dateDirs = readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^review-\d{4}-\d{2}-\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort()
      .reverse(); // ISO dates sort lexicographically — newest date first
  } catch { return null; }

  for (const dateDir of dateDirs) {
    const dateDirPath = join(baseDir, dateDir);
    let runDirs;
    try {
      runDirs = readdirSync(dateDirPath, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^review-\d+(-pr-\d+)?$/.test(d.name))
        .map((d) => d.name);
    } catch { continue; }
    const withCounter = runDirs
      .map((name) => ({ name, counter: Number(/^review-(\d+)/.exec(name)[1]) }))
      .filter((x) => existsSync(join(dateDirPath, x.name, 'review.md')))
      // explicit tie-break (name) so two same-counter dirs (shouldn't happen, but determinism
      // per contract 4) always resolve the same way rather than depending on readdir order.
      .sort((a, b) => b.counter - a.counter || b.name.localeCompare(a.name));
    if (withCounter.length) return join(dateDirPath, withCounter[0].name);
  }
  return null;
}

const SEV_HEADINGS = new Set(['critical', 'important', 'minor', 'suggestion']);
// Mirrors render.mjs's exact finding bullet: `- **title** (tags) — `file:line` _(conf N)_`
// followed by optional `  - evidence: ...` / `  - fix: ...` lines. review.md is the only durable
// record of a run's findings (report.mjs writes no raw findings JSON), so this is the sole way
// /review-respond recovers them.
const FINDING_RE = /^- \*\*(.+?)\*\* \((.*?)\) — `(.+):(\d+)` _\(conf (\d+)\)_\s*$/;
const EVIDENCE_RE = /^ {2}- evidence: (.*)$/;
const FIX_RE = /^ {2}- fix: (.*)$/;

// Pure: parse review.md back into finding objects. `id` is assigned by encounter order — stable
// for a given file's contents (contract 4: no Date/random in an identity-generating function).
export function parseFindingsFromReport(markdown) {
  const findings = [];
  let severity = null;
  let current = null;
  let n = 0;
  for (const raw of String(markdown ?? '').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(raw);
    if (heading) {
      const word = heading[1].trim().toLowerCase();
      severity = SEV_HEADINGS.has(word) ? word : null;
      current = null;
      continue;
    }
    if (!severity) continue;
    const m = FINDING_RE.exec(raw);
    if (m) {
      const [, title, tagsStr, file, line, confidence] = m;
      const tags = tagsStr.split('·').map((t) => t.trim()).filter(Boolean);
      const verifyTag = tags.find((t) => /^verified ×\d+$/.test(t));
      current = {
        id: `f${n++}`,
        severity,
        dimension: /^D\d+$/.test(tags[0]) ? tags[0] : null,
        title,
        file,
        line: Number(line),
        confidence: Number(confidence),
        isNew: tags.includes('new'),
        recurring: tags.includes('recurring'),
        verify: verifyTag ? { passes: Number(/×(\d+)/.exec(verifyTag)[1]) } : null,
        evidence: '',
        fix: '',
      };
      findings.push(current);
      continue;
    }
    if (!current) continue;
    const ev = EVIDENCE_RE.exec(raw);
    if (ev) { current.evidence = ev[1]; continue; }
    const fx = FIX_RE.exec(raw);
    if (fx) current.fix = fx[1];
  }
  return findings;
}

// --- forbidden performative agreement (ported from the superpowers plugin's
// receiving-code-review skill — its "Forbidden Responses" / "Acknowledging Correct Feedback" lists) ---
export const FORBIDDEN_PHRASES = [
  "you're absolutely right", 'youre absolutely right',
  "you're right", 'youre right',
  'great point', 'great catch', 'great feedback',
  'excellent point', 'excellent catch', 'excellent feedback',
  'thanks for catching', 'thanks for pointing', 'thank you for catching', 'thank you for pointing',
  'let me implement that now',
];
export function containsPerformativePhrase(text) {
  const t = String(text ?? '').toLowerCase();
  return FORBIDDEN_PHRASES.some((p) => t.includes(p));
}

const VALID_STANCES = new Set(['agree', 'disagree', 'needs-human']);

// Pure: validate the finding-responder's output contract { responses:[{id,stance,evidence,applied}] }.
// errors block (malformed contract); warnings flag things worth a human's attention but don't
// invalidate the batch (a disagree without a citation, or performative language slipping through).
export function validateResponses(responses) {
  const errors = [];
  const warnings = [];
  if (!Array.isArray(responses)) return { valid: false, errors: ['responses must be an array'], warnings };
  responses.forEach((r, i) => {
    const where = `responses[${i}]`;
    if (!r || typeof r !== 'object') { errors.push(`${where}: not an object`); return; }
    if (typeof r.id !== 'string' || !r.id) errors.push(`${where}.id: required non-empty string`);
    if (!VALID_STANCES.has(r.stance)) errors.push(`${where}.stance: must be one of agree|disagree|needs-human, got "${r.stance}"`);
    if (typeof r.evidence !== 'string' || !r.evidence.trim()) errors.push(`${where}.evidence: required — never performative, never blank`);
    if ('applied' in r && typeof r.applied !== 'boolean') errors.push(`${where}.applied: must be boolean when present`);
    if (r.stance === 'disagree' && typeof r.evidence === 'string' && !/:\d+/.test(r.evidence)) {
      warnings.push(`${where}: disagree without a file:line citation in evidence`);
    }
    if (containsPerformativePhrase(r.evidence)) {
      warnings.push(`${where}: evidence reads as performative agreement — restate the technical reason instead`);
    }
  });
  return { valid: errors.length === 0, errors, warnings };
}

// Pure: refuse a dirty tree / detached HEAD only when --fix is actually going to write. The
// no-fix path never mutates anything, so neither condition matters there.
export function evaluateScopeGuard({ dirty = false, detachedHead = false, fix = false } = {}) {
  if (fix && dirty) {
    return { blocked: true, reason: 'working tree is dirty — commit or stash before --fix (edits could mix with unrelated changes and an unsafe revert)' };
  }
  if (fix && detachedHead) {
    return { blocked: true, reason: 'HEAD is detached — --fix requires being on a real branch, not a detached review checkout' };
  }
  return { blocked: false, reason: null };
}

// --- fix application: PURE planning/orchestration over injected apply/test/revert callbacks.
// No shell-out here — the real fs/execSync callbacks are wired only in the CLI `apply` subcommand
// below, so this is unit-testable with mocks (idempotence, revert-on-regression) without touching
// disk or spawning a process. ---
export async function applyOneFix(finding, callbacks = {}, opts = {}) {
  const { applyEdit, runTests, revertEdit } = callbacks;
  const { testsCommand = null, confirmed = false } = opts;
  const id = finding?.id;
  if (!confirmed) {
    return { id, applied: false, reason: '--fix requires one explicit user confirmation before the first write' };
  }
  if (finding.stance !== 'agree') {
    return { id, applied: false, reason: `stance is "${finding.stance}", not agree` };
  }
  const edit = finding.edit;
  if (!edit || !edit.file || typeof edit.oldString !== 'string' || typeof edit.newString !== 'string') {
    return { id, applied: false, reason: 'no exact-replace edit to apply' };
  }

  let applyResult;
  try { applyResult = await applyEdit(edit); }
  catch (e) { return { id, applied: false, reason: `apply failed: ${e.message}` }; }
  if (!applyResult?.ok) {
    // Covers idempotence: re-running an already-applied edit finds the old text gone and
    // degrades to a skip, never a crash or a double-apply.
    return { id, applied: false, reason: applyResult?.reason ?? 'apply failed' };
  }

  if (testsCommand) {
    let testResult;
    try { testResult = await runTests(testsCommand); }
    catch (e) { testResult = { passed: false, error: e.message }; }
    if (!testResult?.passed) {
      try { await revertEdit(edit, applyResult); }
      catch (e) { return { id, applied: false, reverted: false, reason: `tests regressed AND revert failed: ${e.message}` }; }
      return { id, applied: false, reverted: true, reason: 'reverted — tests regressed after this edit' };
    }
  }
  return { id, applied: true };
}

// Apply a batch in order, one at a time, under a single confirmation covering the whole run.
export async function applyFixes(findings, callbacks = {}, opts = {}) {
  const results = [];
  for (const f of findings ?? []) results.push(await applyOneFix(f, callbacks, opts));
  return results;
}

// Pure: shape a `disagree` stance into the { question, file, evidence } needsHuman entry
// memory.mjs's recordRun expects, so a disagreement lands in learnings.json as an FP candidate
// (WS2's loop, from the author side) rather than being silently dropped.
export function buildFpCandidate(response, finding = {}) {
  const loc = finding.file ? `${finding.file}${finding.line ? ':' + finding.line : ''}` : 'unknown location';
  return {
    question: `Reviewer flagged "${finding.title ?? response.id}" at ${loc} — author disagreed. False positive?`,
    file: finding.file ?? null,
    evidence: response.evidence ?? '',
  };
}

// --- thin CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const flag = (name) => process.argv.includes(`--${name}`);
  const readStdin = () => new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => resolve(buf));
  });
  const readConfig = () => {
    try { return JSON.parse(readFileSync(`${defaultAcrDir()}/config.json`, 'utf8')); }
    catch { return {}; }
  };
  const tryGit = (args) => {
    try { return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
    catch { return null; }
  };
  const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + '\n');

  const sub = process.argv[2];
  try {
    if (sub === 'validate') {
      const input = JSON.parse((await readStdin()) || '{}');
      const result = validateResponses(input.responses ?? input);
      print(result);
      if (!result.valid) process.exit(1);
    } else if (sub === 'find') {
      const dir = arg('dir', defaultAcrDir());
      const reportArg = arg('report');
      const notes = [];
      let folderPath = reportArg ?? findLatestReportFolder(dir);
      if (folderPath && !existsSync(join(folderPath, 'review.md'))) {
        notes.push(`${folderPath} has no review.md — not a review report folder`);
        folderPath = null;
      }
      if (!folderPath) notes.push(`no review report found under ${dir} — run /review first`);
      const findings = folderPath ? parseFindingsFromReport(readFileSync(join(folderPath, 'review.md'), 'utf8')) : [];
      print({ folderPath, findings, notes });
    } else if (sub === 'scope') {
      const fix = flag('fix');
      const status = tryGit(['status', '--porcelain']);
      const dirty = !!status && status.length > 0;
      const branch = tryGit(['symbolic-ref', '-q', '--short', 'HEAD']);
      const detachedHead = !branch;
      const { blocked, reason } = evaluateScopeGuard({ dirty, detachedHead, fix });
      print({ dirty, detachedHead, blocked, reason });
    } else if (sub === 'apply') {
      const input = JSON.parse((await readStdin()) || '{}');
      const config = readConfig();
      const testsCommand = (typeof config.tests?.command === 'string' && config.tests.command) ? config.tests.command : null;
      const timeoutMs = config.tests?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      const applyEdit = (edit) => {
        let content;
        try { content = readFileSync(edit.file, 'utf8'); }
        catch (e) { return { ok: false, reason: `cannot read ${edit.file}: ${e.message}` }; }
        const count = content.split(edit.oldString).length - 1;
        if (count !== 1) {
          return { ok: false, reason: `old text ${count === 0 ? 'not found' : `found ${count} times (not unique)`} in ${edit.file} — refusing an ambiguous replace` };
        }
        writeFileSync(edit.file, content.replace(edit.oldString, edit.newString));
        return { ok: true, previousContent: content };
      };
      const runTests = (command) => {
        try {
          execSync(command, { stdio: 'pipe', encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
          return { passed: true };
        } catch (e) {
          return { passed: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
        }
      };
      const revertEdit = (edit, applyResult) => { writeFileSync(edit.file, applyResult.previousContent); };

      const result = await applyOneFix(input, { applyEdit, runTests, revertEdit }, { testsCommand, confirmed: input.confirmed === true });
      print(result);
    } else if (sub === 'record') {
      const input = JSON.parse((await readStdin()) || '{}');
      const responses = input.responses ?? [];
      const findings = input.findings ?? [];
      const byId = new Map(findings.map((f) => [f.id, f]));
      const config = readConfig();
      const learning = config.learning ?? { enabled: true, store: `${defaultAcrDir()}/learnings.json` };
      const disagreements = responses.filter((r) => r.stance === 'disagree').map((r) => buildFpCandidate(r, byId.get(r.id) ?? {}));
      let recorded = 0;
      if (disagreements.length && learning.enabled !== false) {
        const store = learning.store ?? `${defaultAcrDir()}/learnings.json`;
        mkdirSync(dirname(store), { recursive: true });
        saveLearnings(store, recordRun(loadLearnings(store), { needsHuman: disagreements }));
        recorded = disagreements.length;
      }
      print({ recorded, store: learning.store ?? `${defaultAcrDir()}/learnings.json` });
    } else {
      console.error('usage: respond.mjs validate|find|scope|apply|record');
      process.exit(2);
    }
  } catch (e) {
    console.error(`respond.mjs: ${e.message}`);
    process.exit(1);
  }
}
