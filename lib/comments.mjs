#!/usr/bin/env node
// CLI: post confidence>=80 findings as inline GitHub PR review comments, with a
// tone the author can act on — one plain-language problem, the evidence, and a
// concrete suggested fix as a code block. Dedupes against existing comments so a
// re-review never double-posts. Requires `gh`.
// Usage: ... | node comments.mjs [--dry-run]
//   stdin: { findings, head, prNumber, existingComments }
import { execFileSync } from 'node:child_process';

function sh(cmd, args, input) { return execFileSync(cmd, args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function have(cmd) { try { sh(cmd, ['--version']); return true; } catch { return false; } }

// --- pure: render one finding into a review comment body ---
export function buildCommentBody(f) {
  const sev = (f.severity || 'note').toUpperCase();
  const lines = [`**${sev} · ${f.dimension || 'review'}** — ${f.title}`, ''];
  if (f.evidence) lines.push(f.evidence, '');
  if (f.fix) {
    lines.push('Suggested fix:');
    lines.push(f.fixCode ? '```' + (f.lang || '') + '\n' + f.fixCode + '\n```' : `> ${f.fix}`);
  }
  if (f.example) lines.push('', `Example: ${f.example}`);
  lines.push('', `_advisory · confidence ${f.confidence ?? '—'}${f.verify ? ` · verified ×${f.verify.passes}` : ''} · adversarial-code-review_`);
  return lines.join('\n');
}

// --- pure: keep only findings not already commented at the same path+line ---
export function dedupComments(findings, existing = []) {
  const seen = new Set(existing.filter((c) => c.path).map((c) => `${c.path}:${c.line}`));
  const seenTitles = new Set(existing.map((c) => (c.body || '').slice(0, 60)));
  return (findings ?? []).filter((f) => {
    if (seen.has(`${f.file}:${f.line}`)) return false;
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
  if (dry) { console.log(JSON.stringify(toPost.map((f) => ({ path: f.file, line: f.line, body: buildCommentBody(f) })), null, 2)); process.exit(0); }
  if (!have('gh')) { console.error('comments.mjs: gh not found — cannot post inline comments'); process.exit(2); }

  const pr = data.prNumber;
  let posted = 0;
  for (const f of toPost) {
    if (!f.file || !f.line || pr == null) continue;
    try {
      sh('gh', ['api', `repos/{owner}/{repo}/pulls/${pr}/comments`, '-f', `body=${buildCommentBody(f)}`, '-f', `commit_id=${data.head}`, '-f', `path=${f.file}`, '-F', `line=${f.line}`, '-f', 'side=RIGHT']);
      posted++;
    } catch { /* skip lines not in the diff hunk */ }
  }
  console.log(`Posted ${posted}/${toPost.length} inline comment(s).`);
}
