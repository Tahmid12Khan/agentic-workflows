#!/usr/bin/env node
// CLI: assemble the review context bundle from every available source:
//   PR title/body/commits, EXISTING PR review comments, ClickUp/Jira issue KEYS
//   (the ticket bodies are fetched by the orchestrator via MCP — no tokens here),
//   and project-rules files. Best-effort — a missing tool degrades gracefully.
// Usage: node gather.mjs --base <ref> [--head <ref>]
// Reads .adversarial-code-review/config.json from cwd. Prints a JSON context bundle to stdout.
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

// Generous ceilings on the raw context bundle carried BY VALUE into the Workflow args (and re-carried
// in the report payload). The intent packet truncates its own prompt copy, but the raw bundle is
// otherwise uncapped: a PR with a huge description or hundreds of commits/review comments can balloon
// args.json past what one tool-call payload should carry. These only bite pathological PRs — a normal
// one is well under — and never drop a source entirely (title/ticket keys/first commits always survive).
export const BUNDLE_LIMITS = { body: 20000, commentBody: 8000, comments: 200, commits: 300 };

// Pure: clamp an assembled bundle in place to BUNDLE_LIMITS (overridable for tests). Records what it
// dropped in bundle.notes so the truncation is visible, never silent.
export function capBundle(bundle, limits = BUNDLE_LIMITS) {
  if (!bundle || typeof bundle !== 'object') return bundle;
  const L = { ...BUNDLE_LIMITS, ...(limits ?? {}) };
  if (!Array.isArray(bundle.notes)) bundle.notes = [];
  const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}… [+${s.length - n} chars]` : s);
  if (bundle.pr && typeof bundle.pr.body === 'string') bundle.pr.body = clip(bundle.pr.body, L.body);
  if (Array.isArray(bundle.commits) && bundle.commits.length > L.commits) {
    bundle.notes.push(`commit list capped to ${L.commits} (+${bundle.commits.length - L.commits} omitted)`);
    bundle.commits = bundle.commits.slice(0, L.commits);
  }
  if (Array.isArray(bundle.existingComments)) {
    for (const c of bundle.existingComments) if (c && typeof c.body === 'string') c.body = clip(c.body, L.commentBody);
    if (bundle.existingComments.length > L.comments) {
      bundle.notes.push(`existing-comment list capped to ${L.comments} (+${bundle.existingComments.length - L.comments} omitted)`);
      bundle.existingComments = bundle.existingComments.slice(0, L.comments);
    }
  }
  return bundle;
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
  // WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the
  // new name; fall back to the old one only if it's the ONLY one present — supports un-migrated
  // installs for one release cycle.
  const ACR_DIR = (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
    ? '.adverserial-code-review'
    : '.adversarial-code-review';
  let config = {};
  if (existsSync(`${ACR_DIR}/config.json`)) { try { config = JSON.parse(readFileSync(`${ACR_DIR}/config.json`, 'utf8')); } catch { /* */ } }
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

  capBundle(bundle);
  bundle.summary = summarizeContext(bundle);
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}
