#!/usr/bin/env node
// CLI: post confidence>=80 findings as inline GitHub PR review comments — terse
// on prose (one-line problem + one-line evidence), concrete on the fix: a real
// GitHub ```suggestion block (one-click apply) when a reviewer supplied an exact
// replacement — single-line, or multi-line via `endLine` for a fix spanning
// several contiguous original lines — else a one-line fix description. Dedupes
// against existing comments so a re-review never double-posts. Requires `gh`.
// After each successful post, seeds BOTH 👍 and 👎 reactions (one-click vote either
// way) and records the comment id + finding key into the posted-comments state
// file (see feedback.mjs) so a later review of the same PR can harvest the human
// reactions/replies (WS2 feedback loop). Both steps are best-effort — a failure
// costs the feedback loop one data point, never the posted comment.
//
// WS3 (re-review convergence): before posting, classifies this run's findings against
// last-review.json's PREVIOUS findings (rereview.mjs's diffFindings) —
//   resolved:   replies "✅ Resolved in <sha>" and resolves the GitHub thread, but ONLY when the
//               finding's OLD file:line region actually changed in prevHead..head (a real git
//               diff, checked here); otherwise it just didn't reproduce this pass — reply
//               "no longer reproduced", never resolve.
//   persisting: never re-posted (the report says "Still open").
//   new:        posted as usual, subject to two convergence levers: `rereview.nit_rounds`
//               (config, default 1) demotes minor/suggestion findings to report-only from round
//               nitRounds+1 on, and `report.max_posted_nits` (default 5) caps how many
//               minor/suggestion findings get posted at all (top-N by confidence; the rest stay
//               in the report file only). Neither lever touches critical/important.
// Every WS3 step is best-effort: a missing `git`/`gh`, no prior state, or no PR number degrades
// to "treat everything as new" (this workstream's behavior is additive over the prior one).
// Usage: ... | node comments.mjs [--dry-run] [--base-dir <dir>]
//   stdin: { findings, head, base, prNumber, existingComments, postedCommentsPath }
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findingKey, loadLastReview } from './memory.mjs';
import { DEFAULT_STORE, loadPostedComments, savePostedComments, recordPostedComments } from './feedback.mjs';
import { diffFindings, classifyVanished, nextRound, nitConvergence } from './rereview.mjs';
import { buildDiffIndex } from './trim-diff.mjs';

function sh(cmd, args, input) { return execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function have(cmd) { try { sh(cmd, ['--version']); return true; } catch { return false; } }

// WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the new
// name; fall back to the old one only if it's the ONLY one present — supports un-migrated installs
// for one release cycle.
function defaultAcrDir() {
  return (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
    ? '.adverserial-code-review'
    : '.adversarial-code-review';
}

// Same optional-config convention as plan.mjs/test-signal.mjs/usage.mjs: read once, default {},
// never throw. Only `rereview.nit_rounds` and `report.max_posted_nits` are consumed here.
function readConfig() {
  try { return JSON.parse(readFileSync(`${defaultAcrDir()}/config.json`, 'utf8')); } catch { return {}; }
}

// Seed one 👍 and one 👎 reaction on a posted comment so both vote buttons render pre-populated.
// Best-effort per reaction: one failing (e.g. a permissions hiccup) must not block the other.
function seedReactions(commentId) {
  for (const content of ['+1', '-1']) {
    try { sh('gh', ['api', `repos/{owner}/{repo}/pulls/comments/${commentId}/reactions`, '-f', `content=${content}`]); }
    catch { /* one less pre-seeded button — harvest still works, just counts one fewer self-seed */ }
  }
}

// --- pure: a finding's GitHub line-anchor. GitHub's own `line` field always means the LAST line
// of the comment's range (true for single- and multi-line comments alike — confirmed against
// gather.mjs's read of the same API), so `endLine` (when > line) makes this a multi-line comment
// and the anchor `line` becomes endLine, with `start_line` carrying the first original line.
export function commentLocation(f) {
  const multiLine = Number.isInteger(f.endLine) && f.endLine > f.line;
  return multiLine ? { line: f.endLine, start_line: f.line, start_side: 'RIGHT' } : { line: f.line };
}

// --- pure: render one finding into a review comment body ---
// fixCode is the exact replacement for the anchored line(s); a suggestion block doesn't care how
// many lines it CONTAINS, only how many ORIGINAL lines it replaces (controlled by commentLocation's
// start_line/line). When fixCode is absent, fall back to a short prose fix instead of guessing.
export function buildCommentBody(f) {
  const sev = (f.severity || 'note').toUpperCase();
  const lines = [`**${sev} · ${f.dimension || 'review'}** — ${f.title}`];
  if (f.evidence) lines.push('', f.evidence);
  if (f.fixCode) {
    if (f.fix) lines.push('', f.fix);
    lines.push('', '```suggestion', f.fixCode, '```');
  } else if (f.fix) {
    lines.push('', `Suggested fix: ${f.fix}`);
  }
  lines.push('', `_advisory · confidence ${f.confidence ?? '—'}${f.verify ? ` · verified ×${f.verify.passes}` : ''} · adversarial-code-review_`);
  return lines.join('\n');
}

// --- pure: build the `gh api` argv for posting one finding as a review comment ---
export function buildCommentArgs(f, { head, pr }) {
  const loc = commentLocation(f);
  const args = ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '-f', `body=${buildCommentBody(f)}`, '-f', `commit_id=${head}`, '-f', `path=${f.file}`, '-F', `line=${loc.line}`, '-f', 'side=RIGHT'];
  if (loc.start_line != null) args.push('-F', `start_line=${loc.start_line}`, '-f', `start_side=${loc.start_side}`);
  return args;
}

// --- WS9 (--comment batching): one review (one notification) instead of N individual comment
// POSTs. buildReviewPayload is the JSON body for `POST .../pulls/{pr}/reviews`; buildReviewArgs is
// the gh argv that sends it via stdin (`--input -`), since gh's `-f`/`-F` flags can't express a
// nested comments array. Trade-off vs individual posts: GitHub validates the WHOLE review
// atomically — one comment anchored outside the diff hunk fails the entire batch — which is
// exactly why the caller falls back to per-comment posting when this call throws.
export function buildReviewPayload(findings, { head }) {
  return {
    commit_id: head,
    event: 'COMMENT',
    comments: (findings ?? []).map((f) => {
      const loc = commentLocation(f);
      return { path: f.file, body: buildCommentBody(f), line: loc.line, side: 'RIGHT', ...(loc.start_line != null ? { start_line: loc.start_line, start_side: loc.start_side } : {}) };
    }),
  };
}
export function buildReviewArgs(pr) {
  return ['api', `repos/{owner}/{repo}/pulls/${pr}/reviews`, '-X', 'POST', '--input', '-'];
}

// --- pure: keep only findings not already commented at the same path+line ---
// Keys off commentLocation's `line` (the GitHub-visible anchor, i.e. the LAST line of a range) so
// this matches how existing comments were reported back to us by gather.mjs.
export function dedupComments(findings, existing = []) {
  const seen = new Set(existing.filter((c) => c.path).map((c) => `${c.path}:${c.line}`));
  const seenTitles = new Set(existing.map((c) => (c.body || '').slice(0, 60)));
  return (findings ?? []).filter((f) => {
    if (seen.has(`${f.file}:${commentLocation(f).line}`)) return false;
    for (const t of seenTitles) if (t.includes((f.title || '').slice(0, 30)) && f.title) return false;
    return true;
  });
}

// --- pure: nit cap (config report.max_posted_nits, default 5) — post only the top-N minor/
// suggestion findings by confidence; critical/important are never capped (they always post,
// subject only to the confidence floor). Stable sort: confidence desc, then file, then line, so
// the selection is deterministic regardless of input order or confidence ties.
export function capNits(findings, maxPostedNits = 5) {
  const nits = [], rest = [];
  for (const f of findings ?? []) ((f.severity === 'minor' || f.severity === 'suggestion') ? nits : rest).push(f);
  const sorted = [...nits].sort((a, b) =>
    (b.confidence ?? 0) - (a.confidence ?? 0) ||
    String(a.file ?? '').localeCompare(String(b.file ?? '')) ||
    (Number(a.line ?? 0) - Number(b.line ?? 0)));
  const cap = Math.max(0, maxPostedNits);
  const kept = sorted.slice(0, cap);
  const dropped = sorted.slice(cap);
  return { posted: [...rest, ...kept], dropped, droppedCount: dropped.length };
}

// --- pure: the gh api argv for a THREAD REPLY (not a new top-level comment) — GitHub creates a
// reply on the same review-comments endpoint via `in_reply_to`.
export function buildReplyArgs(commentId, body, { pr }) {
  return ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '-f', `body=${body}`, '-F', `in_reply_to=${commentId}`];
}

export function resolvedReplyBody(headSha) {
  return `✅ Resolved in \`${String(headSha || '').slice(0, 8)}\`.`;
}
export const NOT_REPRODUCED_BODY = 'This finding did not reproduce in this review, but the flagged code is unchanged since the last one — marking **no longer reproduced** rather than resolved (verify manually before closing the thread).';

// --- pure: the GraphQL mutation body that resolves a review thread by its node id.
export function resolveThreadMutation(threadId) {
  return `mutation { resolveReviewThread(input: { threadId: "${threadId}" }) { thread { id isResolved } } }`;
}

export function buildSummaryComment({ verdict, tier, findings = [], needsHuman = [] }) {
  const bySev = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const counts = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', ') || 'no blocking findings';
  return [`### Code review — **${verdict}** (tier: ${tier})`, '', counts + '.',
    needsHuman.length ? `\n⚠ ${needsHuman.length} item(s) need your input — see the report.` : '',
    '\n_advisory — never edits the code under review; fixes applied only via opt-in `/review-respond --fix` · adversarial-code-review_'].join('\n');
}

// Look up the GraphQL thread node id for a REST review-comment id — resolveReviewThread's
// mutation takes the former, not the latter. Best-effort: any failure (no graphql access, no
// matching thread found) → null, so the caller just leaves that one thread unresolved.
function findThreadId(pr, commentDatabaseId) {
  try {
    const query = 'query($owner:String!,$repo:String!,$pr:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$pr){ reviewThreads(first:100){ nodes { id comments(first:1){ nodes { databaseId } } } } } } }';
    const out = sh('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', 'owner={owner}', '-f', 'repo={repo}', '-F', `pr=${pr}`]);
    const nodes = JSON.parse(out)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.find((n) => n.comments?.nodes?.[0]?.databaseId === commentDatabaseId)?.id ?? null;
  } catch { return null; }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry-run');
  const argv = process.argv;
  const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : def; };
  const baseDir = arg('--base-dir', defaultAcrDir());
  const input = await new Promise((r) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => r(b)); });
  const data = JSON.parse(input || '{}');

  // WS3: classify against the PREVIOUS run's findings. `--comment` runs before report.mjs in the
  // review.md pipeline specifically so last-review.json here is still the prior run's state (report.mjs
  // overwrites it afterward). No prior state (first review, or a missing/corrupt file) → prevReview is
  // null → everything below is "new", identical to pre-WS3 behavior.
  const prevReview = loadLastReview(join(baseDir, 'last-review.json'));
  const config = readConfig();
  const nitRounds = Number(config.rereview?.nit_rounds ?? 1);
  const maxPostedNits = Number(config.report?.max_posted_nits ?? 5);
  const round = nextRound(prevReview, { base: data.base ?? null, prNumber: data.prNumber ?? null });
  const { resolved, persisting, new: freshFindings } = diffFindings(prevReview?.findings ?? [], data.findings ?? []);

  const eligible = freshFindings.filter((f) => (f.confidence ?? 100) >= 80);
  const { postable } = nitConvergence(eligible, round, nitRounds);
  const deduped = dedupComments(postable, data.existingComments);
  const { posted: toPost, droppedCount } = capNits(deduped, maxPostedNits);

  if (dry) { console.log(JSON.stringify(toPost.map((f) => ({ path: f.file, ...commentLocation(f), body: buildCommentBody(f) })), null, 2)); process.exit(0); }
  if (!have('gh')) { console.error('comments.mjs: gh not found — cannot post inline comments'); process.exit(2); }

  const pr = data.prNumber;
  let posted = 0;
  const postedRecords = [];

  // WS9: prefer ONE review (one notification) over N individual comment POSTs. GitHub validates a
  // batched review atomically (one comment outside the diff hunk fails the WHOLE call) — exactly
  // why a thrown batch call falls back to per-comment posting below, never a partial mix of both.
  const anchored = toPost.filter((f) => f.file && f.line);
  let batchDone = false;
  if (anchored.length && pr != null) {
    let reviewOut = null;
    try { reviewOut = sh('gh', buildReviewArgs(pr), JSON.stringify(buildReviewPayload(anchored, { head: data.head }))); }
    catch { /* batch POST failed — nothing was created; fall back to per-comment below */ }
    if (reviewOut != null) {
      batchDone = true;
      posted = anchored.length;
      // Resolve each posted comment's id (needed for seedReactions + feedback-loop state) —
      // best-effort: if this lookup fails, the comments are still posted, just without reactions/state.
      try {
        const review = JSON.parse(reviewOut);
        const reviewComments = JSON.parse(sh('gh', ['api', `repos/{owner}/{repo}/pulls/${pr}/reviews/${review.id}/comments`]));
        const used = new Set();
        for (const f of anchored) {
          const loc = commentLocation(f);
          const match = reviewComments.find((c) => c.path === f.file && c.line === loc.line && !used.has(c.id));
          if (match) {
            used.add(match.id);
            seedReactions(match.id);
            postedRecords.push({ id: match.id, key: findingKey(f), file: f.file, line: loc.line, title: f.title ?? null });
          }
        }
      } catch { /* review posted but comment ids unresolved — reactions/state skipped this run only */ }
    }
  }

  if (!batchDone) {
    for (const f of toPost) {
      if (!f.file || !f.line || pr == null) continue;
      try {
        const out = sh('gh', buildCommentArgs(f, { head: data.head, pr }));
        posted++;
        let id = null;
        try { id = JSON.parse(out).id ?? null; } catch { /* unexpected response shape — skip state recording */ }
        if (id != null) {
          seedReactions(id);
          postedRecords.push({ id, key: findingKey(f), file: f.file, line: commentLocation(f).line, title: f.title ?? null });
        }
      } catch { /* skip lines not in the diff hunk */ }
    }
  }
  const postedCommentsPath = data.postedCommentsPath ?? DEFAULT_STORE;
  if (postedRecords.length) {
    try {
      const state = recordPostedComments(loadPostedComments(postedCommentsPath), { pr, base: data.base ?? null, head: data.head ?? null, comments: postedRecords });
      savePostedComments(postedCommentsPath, state);
    } catch { /* feedback loop just won't have state for this run */ }
  }
  console.log(`Posted ${posted}/${toPost.length} inline comment(s).`);
  if (droppedCount) console.log(`  +${droppedCount} similar nit(s) not posted (report.max_posted_nits: ${maxPostedNits}) — see the report file.`);
  if (persisting.length) console.log(`${persisting.length} finding(s) persisting from the last review — not re-posted (see "Still open" in the report).`);

  // WS3: reply-and-maybe-resolve threads for findings the last review flagged that this one didn't
  // reproduce. Needs a PR + the prior comment id (from posted-comments.json — the live, always-current
  // source; unlike last-review.json's own embedded commentId it can never lag a run behind, since it's
  // written at the end of every --comment run and only ever read here, never carried forward stale).
  // Best-effort throughout: a missing PR/git/gh, or no comment ever recorded for the key, just leaves
  // that one thread as-is.
  if (resolved.length && pr != null) {
    const priorComments = loadPostedComments(postedCommentsPath).prs[String(pr)]?.comments ?? [];
    const byKey = new Map(priorComments.map((c) => [c.key, c]));
    let diffIndex = {};
    if (prevReview?.head && data.head && prevReview.head !== data.head && have('git')) {
      try { diffIndex = buildDiffIndex(sh('git', ['diff', '--unified=0', prevReview.head, data.head])); }
      catch { /* no diff available — every candidate below degrades to "no longer reproduced" */ }
    }
    const { resolved: fixed, notReproduced } = classifyVanished(resolved, diffIndex);
    let repliedResolved = 0, repliedNotReproduced = 0;
    for (const f of fixed) {
      const rec = byKey.get(findingKey(f));
      if (!rec) continue;   // never posted (or state lost) — nothing to reply to/resolve
      try {
        sh('gh', buildReplyArgs(rec.id, resolvedReplyBody(data.head), { pr }));
        repliedResolved++;
        const threadId = findThreadId(pr, rec.id);
        if (threadId) sh('gh', ['api', 'graphql', '-f', `query=${resolveThreadMutation(threadId)}`]);
      } catch { /* best-effort — a failed reply/resolve never blocks the rest of the run */ }
    }
    for (const f of notReproduced) {
      const rec = byKey.get(findingKey(f));
      if (!rec) continue;
      try { sh('gh', buildReplyArgs(rec.id, NOT_REPRODUCED_BODY, { pr })); repliedNotReproduced++; }
      catch { /* best-effort */ }
    }
    if (repliedResolved || repliedNotReproduced) console.log(`Threads: ${repliedResolved} resolved, ${repliedNotReproduced} marked no-longer-reproduced.`);
  }
}
