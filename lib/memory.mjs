#!/usr/bin/env node
// Per-project memory: learnings persist across runs in .adversarial-code-review/learnings.json.
// Stores recurring findings, accepted false-positives (so we stop re-flagging
// them), and unresolved questions the human still owes an answer to. Pure
// helpers below; thin CLI at the bottom.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const EMPTY = {
  version: 2,
  acceptedFalsePositives: [], // [{ key, note, context? }]
  recurring: [],              // [{ key, count, lastSeen }]
  unresolved: [],             // [{ question, file, askedAt, context }]
};

// v1 -> v2 is otherwise a no-op today; kept as the seam for the next shape change. Loaded v1
// files keep loading (contract: "v1 files must still load"); unknown keys on disk (e.g. an old
// file's now-removed fields) pass through the spread untouched but are never read.
export function migrateLearnings(o) {
  if (!o || typeof o !== 'object') return { ...EMPTY };
  return { ...EMPTY, ...o, version: 2 };
}

export function loadLearnings(path) {
  if (!path || !existsSync(path)) return { ...EMPTY };
  try { return migrateLearnings(JSON.parse(readFileSync(path, 'utf8'))); }
  catch { return { ...EMPTY }; }
}

export function saveLearnings(path, learnings) {
  writeFileSync(path, JSON.stringify(learnings, null, 2) + '\n');
}

// Stable identity for a finding across runs — deliberately LINE-INSENSITIVE
// (file + title only) so a learning still matches when the finding drifts to a
// new line. For in-run dedup (e.g. the exhaustive double-run), use a line-aware
// file:line:title key instead — this one would collapse two same-title findings at different lines.
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

// Fold harvested PR reactions (feedback.mjs's `results`) into learnings, immutably.
// down>=1 && up==0 on a finding key is a team false-positive verdict: append to
// acceptedFalsePositives (future runs suppress it via applyLearnings above), noting which PR
// and carrying reply text as context for a future reviewer packet.
// aggregateFeedback already drops ties (up === down).
export function applyFeedback(learnings, results = [], { pr = null } = {}) {
  const next = clone(learnings ?? EMPTY);
  const fps = [...(next.acceptedFalsePositives ?? [])];
  const fpSeen = new Set(fps.map((x) => x.key));
  for (const r of results ?? []) {
    if (r.down >= 1 && r.up === 0 && !fpSeen.has(r.key)) {
      fpSeen.add(r.key);
      fps.push({ key: r.key, note: `👎 on PR #${pr ?? '?'}`, context: (r.replies ?? []).join('\n').slice(0, 300) });
    }
  }
  next.acceptedFalsePositives = fps;
  return next;
}

// For incremental review: which findings are new vs carried over from last run.
export function dedupAgainstPrevious(findings, previous = []) {
  const prev = new Set((previous ?? []).map(findingKey));
  return (findings ?? []).map((f) => ({ ...f, isNew: !prev.has(findingKey(f)) }));
}

// --- Incremental-review state (.adversarial-code-review/last-review.json) ---
// Persisted after every review (script-written by report.mjs) so a later `/review --incremental`
// can narrow the diff to only the commits added since. base/head are the reviewed shas; `findings`
// (minimal {file,title,dimension}) let dedupAgainstPrevious tag which findings are new vs carried
// over. No Date — the reviewed shas + range are the only run identity kept (contract 4).

// Degrades to null on any read/parse failure (missing file, corrupt JSON) so a missing/broken
// state simply forces a full review — never a crash.
export function loadLastReview(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    return (o && typeof o === 'object') ? o : null;
  } catch { return null; }
}

// v1 -> v2 (WS3, re-review convergence): each finding now also carries `severity`, `line`, its
// `key` (memory.findingKey — file+title, line-insensitive), and `commentId` — the GitHub review
// comment id a prior --comment run posted for it, when known. State also gains `round` (the
// convergence counter — see rereview.nextRound) and `prNumber` (round's same-PR identity check).
// commentIdByKey is an optional Map<key, id> the caller resolves from posted-comments.json (see
// feedback.mjs) — best-effort: a finding's own `commentId` (if the caller already carries one)
// is the fallback, then null. Every v1 reader still gets file/title/dimension unchanged (additive).
export function buildLastReview({ base = null, head = null, range = null, findings = [], round = 1, prNumber = null, commentIdByKey = null } = {}) {
  return {
    version: 2,
    base, head, range, round, prNumber,
    findings: (findings ?? []).map((f) => {
      const key = findingKey(f);
      return {
        file: f?.file ?? null,
        title: f?.title ?? null,
        dimension: f?.dimension ?? null,
        severity: f?.severity ?? null,
        line: f?.line ?? null,
        key,
        commentId: commentIdByKey?.get(key) ?? f?.commentId ?? null,
      };
    }),
  };
}

export function saveLastReview(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

// Decide the diff range for an incremental review. `isAncestor(a, b)` must return true ONLY when a is
// an ancestor of b (a clean fast-forward advance); it is injected so this stays pure + unit-testable.
// Policy (S9 of plan.md): narrow to prevHead..head ONLY on a fast-forward. On ANY non-fast-forward
// (rebase, force-push, amend), a missing prevHead, or an unchanged head, FAIL OPEN to the full
// base..head review — the merge-time rebase/force-push is the exact event most likely to introduce
// bugs, and a stale prevHead..head would silently drop the rewritten commits.
export function resolveIncrementalRange({ base, head, prevHead, isAncestor } = {}) {
  const full = `${base}..${head}`;
  if (!prevHead) return { range: full, incremental: false, prevHead: null, reason: 'no prior review state — full review' };
  if (prevHead === head) return { range: full, incremental: false, prevHead: null, reason: 'head unchanged since last review — full review' };
  let ff = false;
  try { ff = isAncestor(prevHead, head) === true; } catch { ff = false; }
  if (!ff) return { range: full, incremental: false, prevHead: null, reason: 'non-fast-forward (rebase/force-push) since last review — full review' };
  return { range: `${prevHead}..${head}`, incremental: true, prevHead, reason: 'fast-forward advance — reviewing only new commits' };
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

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// --- CLI: `memory.mjs load <path>` | `memory.mjs record <path>` | `memory.mjs feedback <path> --pr <n>` (JSON on stdin) ---
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
  } else if (cmd === 'feedback') {
    const i = process.argv.indexOf('--pr');
    const pr = i >= 0 ? Number(process.argv[i + 1]) : null;
    const buf = await read(process.stdin);
    const harvested = JSON.parse(buf || '{}');
    const next = applyFeedback(loadLearnings(path), harvested.results ?? [], { pr: pr ?? harvested.pr ?? null });
    saveLearnings(path, next);
    console.log(`feedback: ${next.acceptedFalsePositives.length} accepted-FP → ${path}`);
  } else {
    console.error('usage: memory.mjs load <path> | memory.mjs record <path> | memory.mjs feedback <path> --pr <n>  (JSON on stdin)');
    process.exit(2);
  }
}
function read(stream) {
  return new Promise((resolve) => { let b = ''; stream.setEncoding('utf8'); stream.on('data', (d) => (b += d)); stream.on('end', () => resolve(b)); });
}
