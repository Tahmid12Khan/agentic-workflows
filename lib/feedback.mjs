#!/usr/bin/env node
// CLI: the finding feedback loop — turns 👍/👎 reactions on posted inline PR comments
// into memory signal. comments.mjs (the posting path) seeds BOTH reactions on every
// comment it posts (so both buttons render) and records { id, key, file, line, title }
// per comment into the posted-comments state file below; this module reads that state
// back on a later review of the SAME pr, fetches the live reaction counts + reply text,
// subtracts the self-seed, and emits one aggregate per finding KEY for memory.mjs's
// applyFeedback to fold into learnings.json. Degrade-only: any `gh` failure yields an
// empty result + a note, never a crash — the caller (commands/review.md) just skips
// the harvest for that run.
//
// State file: .adversarial-code-review/posted-comments.json (git-ignored — transient,
// PR-scoped run state, same spirit as last-review.json)
//   { version: 1, prs: { "<pr>": { base, head, comments: [{ id, key, file, line, title }] } } }
//
// Usage: node feedback.mjs harvest --pr <n> [--store <path>]
//   stdout: { pr, results: [{ key, up, down, replies }], notes }
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the new
// name; fall back to the old one only if it's the ONLY one present — supports un-migrated installs
// for one release cycle.
const ACR_DIR = (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
  ? '.adverserial-code-review'
  : '.adversarial-code-review';
export const DEFAULT_STORE = `${ACR_DIR}/posted-comments.json`;
const EMPTY_STATE = { version: 1, prs: {} };

// --- posted-comments state (written by comments.mjs, read by this module) ---
export function loadPostedComments(path) {
  if (!path || !existsSync(path)) return { ...EMPTY_STATE, prs: {} };
  try {
    const o = JSON.parse(readFileSync(path, 'utf8'));
    return (o && typeof o === 'object') ? { version: 1, prs: o.prs ?? {} } : { ...EMPTY_STATE, prs: {} };
  } catch { return { ...EMPTY_STATE, prs: {} }; }
}

export function savePostedComments(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

// Fold newly-posted comments for one PR into the store (immutable). Dedupes by comment id so a
// re-review that posts alongside earlier, still-unharvested comments doesn't drop them.
export function recordPostedComments(state, { pr, base = null, head = null, comments = [] }) {
  const prior = state?.prs?.[String(pr)]?.comments ?? [];
  const byId = new Map(prior.map((c) => [c.id, c]));
  for (const c of comments) byId.set(c.id, c);
  return { version: 1, prs: { ...(state?.prs ?? {}), [String(pr)]: { base, head, comments: [...byId.values()] } } };
}

// --- pure: reaction/reply parsing ---
// `gh api .../reactions` returns the raw reaction list; count the two vote kinds only.
export function countReactions(reactions = []) {
  let plus1 = 0, minus1 = 0;
  for (const r of reactions ?? []) {
    if (r?.content === '+1') plus1++;
    else if (r?.content === '-1') minus1++;
  }
  return { plus1, minus1 };
}

// comments.mjs seeds exactly one 👍 and one 👎 on every posted comment (so both buttons render);
// subtract that seed to get the human signal. Floored at 0 so a seed call that failed to post
// (gh error) never reads as a phantom down-vote.
export function subtractSeed({ plus1 = 0, minus1 = 0 } = {}) {
  return { up: Math.max(0, plus1 - 1), down: Math.max(0, minus1 - 1) };
}

// Replies to a review comment are further PR comments with in_reply_to_id === the original's id.
// Truncated to 300 chars — evidence for a future reviewer packet, never instructions (the PR-content
// trust boundary applies same as any other harvested text).
export function extractReplies(allComments, commentId) {
  return (allComments ?? [])
    .filter((c) => c?.in_reply_to_id === commentId)
    .map((c) => String(c?.body ?? '').slice(0, 300));
}

// Aggregate by finding KEY (not comment id) — the same finding can have been posted more than once
// across re-reviews (title stable, line drifted). Ties (up === down, including 0 === 0 = no votes)
// are a no-op: no signal, nothing recorded.
export function aggregateFeedback(comments, reactionsById, allComments = []) {
  const byKey = new Map();
  for (const c of comments ?? []) {
    const { up, down } = subtractSeed(countReactions(reactionsById?.get(c.id) ?? []));
    const cur = byKey.get(c.key) ?? { key: c.key, up: 0, down: 0, replies: [] };
    cur.up += up;
    cur.down += down;
    cur.replies.push(...extractReplies(allComments, c.id));
    byKey.set(c.key, cur);
  }
  return [...byKey.values()].filter((f) => f.up !== f.down);
}

function sh(cmd, args) { return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function have(cmd) { try { sh(cmd, ['--version']); return true; } catch { return false; } }

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; };
  if (process.argv[2] !== 'harvest') {
    console.error('usage: feedback.mjs harvest --pr <n> [--store <path>]');
    process.exit(2);
  }
  const pr = arg('--pr');
  if (!pr) { console.error('feedback.mjs harvest: --pr <n> is required'); process.exit(2); }
  const storePath = arg('--store', DEFAULT_STORE);

  const notes = [];
  const comments = loadPostedComments(storePath).prs[String(pr)]?.comments ?? [];
  let results = [];
  if (!comments.length) {
    notes.push('no posted comments recorded for this PR — nothing to harvest');
  } else if (!have('gh')) {
    notes.push('gh not found — feedback harvest skipped');
  } else {
    const reactionsById = new Map();
    for (const c of comments) {
      try { reactionsById.set(c.id, JSON.parse(sh('gh', ['api', `repos/{owner}/{repo}/pulls/comments/${c.id}/reactions`]))); }
      catch { notes.push(`reactions fetch failed for comment ${c.id}`); }
    }
    let allComments = [];
    try { allComments = JSON.parse(sh('gh', ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '--paginate'])); }
    catch { notes.push('reply fetch failed — proceeding without reply evidence'); }
    results = aggregateFeedback(comments, reactionsById, allComments);
  }
  process.stdout.write(JSON.stringify({ pr: Number(pr), results, notes }, null, 2) + '\n');
}
