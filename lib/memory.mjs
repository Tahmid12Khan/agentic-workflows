#!/usr/bin/env node
// Per-project memory: learnings persist across runs in .review/learnings.json.
// Stores recurring findings, accepted false-positives (so we stop re-flagging
// them), conventions inferred from past reviews, and unresolved questions the
// human still owes an answer to. Pure helpers below; thin CLI at the bottom.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const EMPTY = {
  version: 1,
  acceptedFalsePositives: [], // [{ key, note }]
  recurring: [],              // [{ key, count, lastSeen }]
  conventions: [],            // ["repo prefers X"]
  unresolved: [],             // [{ question, file, askedAt, context }]
};

export function loadLearnings(path) {
  if (!path || !existsSync(path)) return { ...EMPTY };
  try { return { ...EMPTY, ...JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { ...EMPTY }; }
}

export function saveLearnings(path, learnings) {
  writeFileSync(path, JSON.stringify(learnings, null, 2) + '\n');
}

// Stable identity for a finding across runs — deliberately LINE-INSENSITIVE
// (file + title only) so a learning still matches when the finding drifts to a
// new line. For in-run loop-until-dry dedup, use a line-aware file:line:title
// key instead — this one would collapse two same-title findings at different lines.
export function findingKey(f) {
  return `${f.file ?? '?'}::${f.title ?? f.dimension ?? '?'}`.toLowerCase();
}

// Drop findings the team already triaged as false-positives; tag the ones we've
// seen before so the report can say "recurring".
export function applyLearnings(findings, learnings = EMPTY) {
  const fp = new Set((learnings.acceptedFalsePositives ?? []).map((x) => x.key));
  const seen = new Map((learnings.recurring ?? []).map((x) => [x.key, x.count]));
  const kept = [], suppressed = [];
  for (const f of findings ?? []) {
    const k = findingKey(f);
    if (fp.has(k)) { suppressed.push({ ...f, suppressedBy: 'accepted-false-positive' }); continue; }
    kept.push(seen.has(k) ? { ...f, recurring: true, seenCount: seen.get(k) } : f);
  }
  return { kept, suppressed };
}

// For incremental review: which findings are new vs carried over from last run.
export function dedupAgainstPrevious(findings, previous = []) {
  const prev = new Set((previous ?? []).map(findingKey));
  return (findings ?? []).map((f) => ({ ...f, isNew: !prev.has(findingKey(f)) }));
}

// Fold this run's outcome back into the store (immutably).
export function recordRun(learnings, { reported = [], needsHuman = [], range } = {}) {
  const next = clone(learnings ?? EMPTY);
  const counts = new Map((next.recurring ?? []).map((x) => [x.key, x]));
  for (const f of reported) {
    const k = findingKey(f);
    const cur = counts.get(k) ?? { key: k, count: 0 };
    counts.set(k, { ...cur, count: cur.count + 1, lastSeen: range ?? null });
  }
  next.recurring = [...counts.values()];
  const open = new Map((next.unresolved ?? []).map((q) => [q.question, q]));
  for (const f of needsHuman) {
    const q = f.question ?? `Is this real? ${f.title}`;
    if (!open.has(q)) open.set(q, { question: q, file: f.file ?? null, askedAt: range ?? null, context: f.evidence ?? '' });
  }
  next.unresolved = [...open.values()];
  return next;
}

// Mark an unresolved question answered (called when the human responds).
export function resolveQuestion(learnings, question, answer) {
  const next = clone(learnings);
  next.unresolved = (next.unresolved ?? []).filter((q) => q.question !== question);
  if (answer === 'false-positive') {
    // future: caller maps question→finding key; kept simple here
  }
  next.conventions = [...(next.conventions ?? []), `${question} → ${answer}`];
  return next;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// --- CLI: `memory.mjs load <path>` | `memory.mjs record <path>` (run on stdin) ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , cmd, path] = process.argv;
  if (cmd === 'load') {
    process.stdout.write(JSON.stringify(loadLearnings(path), null, 2) + '\n');
  } else if (cmd === 'record') {
    const buf = await read(process.stdin);
    const run = JSON.parse(buf || '{}');
    const next = recordRun(loadLearnings(path), run);
    saveLearnings(path, next);
    console.log(`learnings: ${next.recurring.length} recurring, ${next.unresolved.length} open question(s) → ${path}`);
  } else {
    console.error('usage: memory.mjs load <path> | memory.mjs record <path>  (run JSON on stdin)');
    process.exit(2);
  }
}
function read(stream) {
  return new Promise((resolve) => { let b = ''; stream.setEncoding('utf8'); stream.on('data', (d) => (b += d)); stream.on('end', () => resolve(b)); });
}
