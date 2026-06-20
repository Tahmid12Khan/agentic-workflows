#!/usr/bin/env node
// CLI: assemble the review context bundle from every available source:
//   PR title/body/commits, EXISTING PR review comments, linked ClickUp/Jira
//   issues, and project-rules files. Everything is best-effort — a missing tool
//   or token degrades gracefully and is noted, never fatal.
// Usage: node gather.mjs --base <ref> [--head <ref>]
// Reads .review/config.json from cwd. Prints a JSON context bundle to stdout.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function sh(cmd, args) { return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString(); }
function tryRun(cmd, args) { try { return sh(cmd, args); } catch { return null; } }

// --- pure: pull issue keys out of free text ---
export function extractIssueKeys(text, pattern) {
  if (!text || !pattern) return [];
  try {
    const re = new RegExp(pattern, 'g');
    return [...new Set((text.match(re) ?? []))];
  } catch { return []; }
}

export function summarizeContext(bundle) {
  const parts = [];
  if (bundle.pr) parts.push(`PR "${bundle.pr.title}"`);
  if (bundle.existingComments?.length) parts.push(`${bundle.existingComments.length} existing comment(s)`);
  if (bundle.tickets?.length) parts.push(`${bundle.tickets.length} ticket(s)`);
  if (bundle.commits?.length) parts.push(`${bundle.commits.length} commit(s)`);
  return parts.join(', ') || 'no external context';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = arg('--base');
  const head = arg('--head', 'HEAD');
  let config = {};
  if (existsSync('.review/config.json')) { try { config = JSON.parse(readFileSync('.review/config.json', 'utf8')); } catch { /* */ } }
  const src = config.intent_sources ?? { pr: true, commits: true, pr_comments: true };
  const notes = [];
  const bundle = { pr: null, existingComments: [], tickets: [], commits: [], rules: [], notes };

  // commits
  if (src.commits && base) {
    const log = tryRun('git', ['log', `${base}..${head}`, '--format=%H%x09%s%x09%an']);
    if (log) bundle.commits = log.split('\n').filter(Boolean).map((l) => { const [sha, subject, author] = l.split('\t'); return { sha, subject, author }; });
  }

  // PR + existing comments via gh
  const hasGh = !!tryRun('gh', ['--version']);
  if (!hasGh) notes.push('gh not available — PR body/comments skipped');
  if (hasGh && (src.pr || src.pr_comments)) {
    const prJson = tryRun('gh', ['pr', 'view', '--json', 'number,title,body,author,commits,comments,reviews']);
    if (prJson) {
      try {
        const pr = JSON.parse(prJson);
        if (src.pr) bundle.pr = { number: pr.number, title: pr.title, body: pr.body, author: pr.author?.login };
        if (src.pr_comments) {
          const issueComments = (pr.comments ?? []).map((c) => ({ kind: 'issue', author: c.author?.login, body: c.body, createdAt: c.createdAt }));
          const reviewComments = (pr.reviews ?? []).map((r) => ({ kind: 'review', author: r.author?.login, body: r.body, state: r.state }));
          // inline review thread comments (file:line) — richer, via the API
          let inline = [];
          const api = pr.number != null ? tryRun('gh', ['api', `repos/{owner}/{repo}/pulls/${pr.number}/comments`, '--paginate']) : null;
          if (api) { try { inline = JSON.parse(api).map((c) => ({ kind: 'inline', author: c.user?.login, body: c.body, path: c.path, line: c.line ?? c.original_line })); } catch { /* */ } }
          bundle.existingComments = [...issueComments, ...reviewComments, ...inline].filter((c) => c.body);
        }
      } catch { notes.push('failed to parse gh pr view'); }
    } else { notes.push('no PR found for this branch'); }
  }

  // trackers (ClickUp / Jira) — keys come from PR/commit text, tokens from env
  const text = [bundle.pr?.title, bundle.pr?.body, ...bundle.commits.map((c) => c.subject)].filter(Boolean).join('\n');
  const tr = config.trackers ?? {};
  if (src.clickup && tr.clickup) {
    const token = process.env[tr.clickup.token_env ?? 'CLICKUP_TOKEN'];
    const keys = extractIssueKeys(text, tr.clickup.key_pattern);
    if (!token) notes.push('ClickUp enabled but token env unset — skipped');
    for (const key of keys.slice(0, 5)) {
      if (!token) break;
      const id = key.replace(/^#|^CU-/i, '');
      const res = await tryFetch(`https://api.clickup.com/api/v2/task/${id}`, { Authorization: token });
      if (res) bundle.tickets.push({ tracker: 'clickup', key, title: res.name, description: res.description, status: res.status?.status });
    }
  }
  if (src.jira && tr.jira?.base_url) {
    const email = process.env[tr.jira.email_env ?? 'JIRA_EMAIL'];
    const token = process.env[tr.jira.token_env ?? 'JIRA_TOKEN'];
    const keys = extractIssueKeys(text, tr.jira.key_pattern);
    if (!email || !token) notes.push('Jira enabled but credentials env unset — skipped');
    for (const key of keys.slice(0, 5)) {
      if (!email || !token) break;
      const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
      const res = await tryFetch(`${tr.jira.base_url.replace(/\/$/, '')}/rest/api/3/issue/${key}`, { Authorization: auth, Accept: 'application/json' });
      if (res) bundle.tickets.push({ tracker: 'jira', key, title: res.fields?.summary, status: res.fields?.status?.name });
    }
  }

  // project rules
  for (const rule of config.project_rules ?? []) {
    if (existsSync(rule)) { try { bundle.rules.push({ path: rule, content: readFileSync(rule, 'utf8').slice(0, 8000) }); } catch { /* */ } }
  }

  bundle.summary = summarizeContext(bundle);
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}

async function tryFetch(url, headers) {
  try { const r = await fetch(url, { headers }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
