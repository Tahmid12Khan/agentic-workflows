#!/usr/bin/env node
// CLI: build a deterministic BUG-HISTORY prior for a change — for each changed file, the recent
//      commit subjects that look like a fix/bug/revert/hotfix/regression. A file with a history of
//      fixes deserves extra scrutiny, and this costs ZERO model tokens (git only).
// Usage: node history.mjs --diff <path>   (or pipe the diff on stdin)
//   Reads the unified diff to learn which files changed, then `git log --oneline -15 -- <file>`
//   per file and keeps only the subjects matching the fix/bug signal. Prints one JSON object:
//   { history: { <file>: [subject, ...] }, notes: [...] } — only files WITH a matching subject
//   appear, so an empty `history` means "no bug history". Attached (post-S3) to the intent-analyzer
//   and correctness-reviewer packets. Advisory + degrade-only: a new file / no history / not a git
//   repo becomes a skip, never a crash; it never edits source.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildDiffIndex } from './trim-diff.mjs';

// Commit-subject signal: a prefix match so `fix:`/`fixes`/`fixed`/`bugfix`/`reverts`/`hotfix`
// all count. Deliberately narrow — a plain word match, never a full-text scan of the body.
export const FIX_RE = /\b(fix|bug|revert|hotfix|regression)/i;
const MAX_FILES = 50;    // per-file git spawns we run before degrading (huge diffs)
const MAX_PER_FILE = 5;  // fix subjects kept per file (the prior, not a changelog)

// Pure: parse `git log --oneline` output into the fix/bug subject lines (short sha stripped),
// capped and de-duped, in log order (newest first). Deterministic; no I/O. Unknown/empty → [].
export function fixSubjects(logText, { max = MAX_PER_FILE, re = FIX_RE } = {}) {
  const out = [];
  const seen = new Set();
  for (const line of String(logText ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const subject = t.replace(/^[0-9a-f]{7,40}\s+/i, '').trim();  // drop the leading abbrev sha
    if (!subject || !re.test(subject) || seen.has(subject)) continue;
    seen.add(subject);
    out.push(subject);
    if (out.length >= max) break;
  }
  return out;
}

// Pure: assemble the { file: [subjects] } prior from a map of file → raw git-log text. Files with
// no matching subject are omitted so the caller attaches the block only when it carries signal.
export function buildHistory(rawByFile = {}, opts = {}) {
  const out = {};
  for (const [file, text] of Object.entries(rawByFile ?? {})) {
    const subjects = fixSubjects(text, opts);
    if (subjects.length) out[file] = subjects;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const diffPath = arg('diff', null);
  let diff = '';
  try { diff = diffPath ? readFileSync(diffPath, 'utf8') : readFileSync(0, 'utf8'); } catch { diff = ''; }

  const notes = [];
  // git log for one file. Exits non-zero / throws when the file is brand-new, the path has no
  // history, or the cwd is not a git repo — every case degrades to "no history", never a crash.
  const logOf = (file) => {
    try { return execFileSync('git', ['log', '--oneline', '-15', '--', file], { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 }).toString(); }
    catch { return ''; }
  };

  const files = Object.keys(buildDiffIndex(diff));
  const scanned = files.slice(0, MAX_FILES);
  if (files.length > scanned.length) notes.push(`history: scanned ${scanned.length} of ${files.length} changed files (cap)`);
  const rawByFile = {};
  for (const file of scanned) rawByFile[file] = logOf(file);
  const history = buildHistory(rawByFile);

  process.stdout.write(JSON.stringify({ history, notes }, null, 2) + '\n');
}
