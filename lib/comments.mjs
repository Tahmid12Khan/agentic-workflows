#!/usr/bin/env node
// CLI: post confidence>=80 findings as inline GitHub PR review comments — terse
// on prose (one-line problem + one-line evidence), concrete on the fix: a real
// GitHub ```suggestion block (one-click apply) when a reviewer supplied an exact
// replacement — single-line, or multi-line via `endLine` for a fix spanning
// several contiguous original lines — else a one-line fix description. Dedupes
// against existing comments so a re-review never double-posts. Requires `gh`.
// Usage: ... | node comments.mjs [--dry-run]
//   stdin: { findings, head, prNumber, existingComments }
import { execFileSync } from 'node:child_process';

function sh(cmd, args, input) { return execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function have(cmd) { try { sh(cmd, ['--version']); return true; } catch { return false; } }

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
// start_line/line). When fixCode is absent, fall back to a one-line prose fix instead of guessing.
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

export function buildSummaryComment({ verdict, tier, findings = [], needsHuman = [] }) {
  const bySev = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const counts = Object.entries(bySev).map(([s, n]) => `${n} ${s}`).join(', ') || 'no blocking findings';
  return [`### Code review — **${verdict}** (tier: ${tier})`, '', counts + '.',
    needsHuman.length ? `\n⚠ ${needsHuman.length} item(s) need your input — see the report.` : '',
    '\n_advisory · never edits code · adversarial-code-review_'].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry-run');
  const input = await new Promise((r) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => r(b)); });
  const data = JSON.parse(input || '{}');
  const toPost = dedupComments((data.findings ?? []).filter((f) => (f.confidence ?? 100) >= 80), data.existingComments);
  if (dry) { console.log(JSON.stringify(toPost.map((f) => ({ path: f.file, ...commentLocation(f), body: buildCommentBody(f) })), null, 2)); process.exit(0); }
  if (!have('gh')) { console.error('comments.mjs: gh not found — cannot post inline comments'); process.exit(2); }

  const pr = data.prNumber;
  let posted = 0;
  for (const f of toPost) {
    if (!f.file || !f.line || pr == null) continue;
    try {
      sh('gh', buildCommentArgs(f, { head: data.head, pr }));
      posted++;
    } catch { /* skip lines not in the diff hunk */ }
  }
  console.log(`Posted ${posted}/${toPost.length} inline comment(s).`);
}
