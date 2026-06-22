#!/usr/bin/env node
// CLI: assemble the review context bundle from every available source:
//   PR title/body/commits, EXISTING PR review comments, ClickUp/Jira issue KEYS
//   (the ticket bodies are fetched by the orchestrator via MCP — no tokens here),
//   and project-rules files. Best-effort — a missing tool degrades gracefully.
// Usage: node gather.mjs --base <ref> [--head <ref>]
// Reads .adverserial-code-review/config.json from cwd. Prints a JSON context bundle to stdout.
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
  if (existsSync('.adverserial-code-review/config.json')) { try { config = JSON.parse(readFileSync('.adverserial-code-review/config.json', 'utf8')); } catch { /* */ } }
  const src = config.intent_sources ?? { pr: true, commits: true, pr_comments: true, clickup: true, jira: true };
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

  // trackers (ClickUp / Jira) — extract issue keys from PR/commit text only.
  // No API tokens here: fetching the ticket bodies is delegated to the orchestrator
  // via MCP (review.md step 3). We surface which keys exist and whether each tracker
  // is enabled so the orchestrator can fetch-or-skip and the report can state usage.
  const text = [bundle.pr?.title, bundle.pr?.body, ...bundle.commits.map((c) => c.subject)].filter(Boolean).join('\n');
  const tr = config.trackers ?? {};
  bundle.ticketKeys = { clickup: [], jira: [] };
  bundle.trackerStatus = {
    clickup: { enabled: !!src.clickup, keys: [] },
    jira: { enabled: !!src.jira, keys: [] },
  };
  if (src.clickup) {
    const keys = extractIssueKeys(text, tr.clickup?.key_pattern ?? '[A-Z][A-Z0-9]+-[0-9]+').slice(0, 5);
    bundle.ticketKeys.clickup = keys;
    bundle.trackerStatus.clickup.keys = keys;
  }
  if (src.jira) {
    const keys = extractIssueKeys(text, tr.jira?.key_pattern ?? '[A-Z][A-Z0-9]+-[0-9]+').slice(0, 5);
    bundle.ticketKeys.jira = keys;
    bundle.trackerStatus.jira.keys = keys;
  }
  const keyCount = bundle.ticketKeys.clickup.length + bundle.ticketKeys.jira.length;
  if (keyCount) notes.push(`${keyCount} ticket key(s) found — fetch via MCP if the tracker's server is connected`);

  // project rules
  for (const rule of config.project_rules ?? []) {
    if (existsSync(rule)) { try { bundle.rules.push({ path: rule, content: readFileSync(rule, 'utf8').slice(0, 8000) }); } catch { /* */ } }
  }

  bundle.summary = summarizeContext(bundle);
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}
