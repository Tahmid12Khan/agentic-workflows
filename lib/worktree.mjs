#!/usr/bin/env node
// CLI: set up / tear down a git worktree so a review runs against the LATEST code
// from the remote (the PR's base + head), not whatever happens to be checked out.
//
//   setup  --base <branch> --head <branch> [--remote origin] [--pr <n>]
//          [--name <n>] [--dir <basedir>]
//   remove --path <worktree-path>
//
// setup fetches base+head from the remote, creates a detached worktree at
// <remote>/<head>, and prints { ok, name, path, remote, base, head, baseRef,
// headRef, sha, range, notes }. Best-effort: if the fetch fails (offline / no
// remote) it notes the skip and falls back to whatever ref resolves locally.
// All file/diff reads then happen inside that worktree; the report is written
// from the main repo so it survives the worktree being removed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function sh(args) { return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
function tryGit(args) { try { return sh(args); } catch { return null; } }

// --- pure helpers (exported for tests) ---
export function sanitizeRef(s) {
  return String(s ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'ref';
}
export function worktreeName({ head, sha, prNumber } = {}) {
  const h = sanitizeRef(head || 'head');
  const short = sha ? String(sha).slice(0, 8) : '';
  const pr = prNumber ? `pr-${prNumber}` : '';
  return ['review', pr, h, short].filter(Boolean).join('-');
}
export function fetchArgs(remote, base, head) {
  return ['fetch', '--no-tags', remote, ...[base, head].filter(Boolean)];
}
export function addArgs(path, ref) {
  return ['worktree', 'add', '--detach', path, ref];
}
export function removeArgs(path) {
  return ['worktree', 'remove', '--force', path];
}
export function rangeFor(baseRef, headRef) {
  return `${baseRef}..${headRef}`;
}

// resolve the ref that actually exists: prefer <remote>/<branch>, else the bare branch.
function resolveRef(remote, branch) {
  for (const ref of [`${remote}/${branch}`, branch]) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sub = process.argv[2];
  const out = {};
  try {
    if (sub === 'setup') {
      const base = arg('--base');
      const head = arg('--head');
      const remote = arg('--remote', 'origin');
      const dir = arg('--dir', '.adverserial-code-review/worktrees');
      const prNumber = arg('--pr');
      const notes = [];
      if (!base || !head) { console.error('worktree.mjs setup: --base and --head are required'); process.exit(2); }

      if (tryGit(fetchArgs(remote, base, head)) === null) notes.push(`could not fetch ${base}/${head} from ${remote} — using local refs`);

      const headRef = resolveRef(remote, head);
      const baseRef = resolveRef(remote, base);
      if (!headRef) { console.error(`worktree.mjs setup: cannot resolve head ref for "${head}"`); process.exit(3); }
      if (!baseRef) notes.push(`cannot resolve base ref for "${base}" — diff range may be wrong`);

      const sha = tryGit(['rev-parse', headRef]) ?? '';
      const name = arg('--name') || worktreeName({ head, sha, prNumber });
      const path = join(dir, name);

      mkdirSync(dir, { recursive: true });
      if (existsSync(path)) tryGit(removeArgs(path)); // stale worktree → recreate at latest
      tryGit(['worktree', 'prune']);
      sh(addArgs(path, headRef)); // throws on real failure — surfaced to caller

      Object.assign(out, {
        ok: true, name, path, remote, base, head,
        baseRef, headRef, sha,
        range: baseRef ? rangeFor(baseRef, headRef) : null,
        notes,
      });
    } else if (sub === 'remove') {
      const path = arg('--path');
      if (!path) { console.error('worktree.mjs remove: --path is required'); process.exit(2); }
      const removed = tryGit(removeArgs(path)) !== null;
      tryGit(['worktree', 'prune']);
      Object.assign(out, { ok: removed, path, removed });
    } else {
      console.error('worktree.mjs: first arg must be "setup" or "remove"');
      process.exit(2);
    }
  } catch (e) {
    console.error(`worktree.mjs: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
