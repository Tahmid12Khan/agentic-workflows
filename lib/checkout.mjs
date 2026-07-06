#!/usr/bin/env node
// CLI: check out the PR's latest pushed head (detached) so the review — AND the
// reviewer subagents' own Read/Grep — see the REAL target code, not a stale local
// checkout. Moving HEAD onto <remote>/<head> is what makes "latest pushed" true for
// every downstream step (plan/gather/reviewers). setup also computes the FORK POINT
// (merge-base of base+head) and returns it as `baseSha`: the command feeds that to
// plan/gather/capture-diff so the reviewed diff is the GitHub three-dot `base...head`
// range — identical hashes to the PR's Files-changed tab even when base has advanced.
//
//   setup     --base <branch> --head <branch> [--remote origin] [--pr <n>]
//   forkpoint --base <branch> [--head <ref>] [--remote origin]   (no fetch, no HEAD move)
//   restore   --ref <original-ref>
//
// setup fetches base+head, records the current ref (branch name, else detached sha),
// and detaches HEAD onto <remote>/<head>. If the checkout is refused because the
// working tree has changes git would overwrite, it prints a stash-and-rerun message
// and exits non-zero — it NEVER stashes for you (could silently lose work, and the
// plugin is advisory). Best-effort fetch: offline / no remote falls back to local
// refs with a note. `restore` checks the recorded ref back out — run it AFTER the
// report is written, so the user lands back where they started.
import { execFileSync } from 'node:child_process';

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
function sh(args) { return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim(); }
function tryGit(args) { try { return sh(args); } catch { return null; } }

// --- pure helpers (exported for tests) ---
export function fetchArgs(remote, base, head) {
  return ['fetch', '--no-tags', remote, ...[base, head].filter(Boolean)];
}
export function checkoutDetachArgs(ref) {
  return ['checkout', '--detach', ref];
}
export function restoreArgs(ref) {
  return ['checkout', ref];
}
export function rangeFor(baseRef, headRef) {
  return `${baseRef}..${headRef}`;
}
// The FORK POINT: the commit where head diverged from base = `git merge-base base head`. Diffing
// from here (three-dot `base...head` semantics) reviews EXACTLY what the PR added — byte- and
// sha-identical to GitHub's Files-changed tab — even when the base branch has advanced past the
// fork (a two-dot `base..head` would then drag in base's newer commits as phantom deletions). This
// is the reviewed boundary; `baseRef` (the branch tip) is kept only for the report header.
export function mergeBaseArgs(baseRef, headRef) {
  return ['merge-base', baseRef, headRef];
}
// commits reachable from base but NOT from head = what the base branch has that the PR hasn't
// integrated. The review diff is two-dot `base..head`, so a stale base shows base's new commits
// as phantom deletions AND can hide real merge/semantic conflicts — we surface these so the
// human can rebase/merge before reviewing.
export function commitsBehindArgs(headRef, baseRef) {
  return ['log', '--no-color', `--pretty=format:%h%x09%s`, `${headRef}..${baseRef}`];
}
export function parseCommits(out, cap = 20) {
  const all = String(out ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
    .map((line) => { const t = line.indexOf('\t'); return t < 0 ? { sha: line, subject: '' } : { sha: line.slice(0, t), subject: line.slice(t + 1) }; });
  return { count: all.length, commits: all.slice(0, cap), truncated: all.length > cap };
}

// Last commit on a ref, for the report's PR-info block: full sha, subject, committer date
// (short YYYY-MM-DD). Unit-separator (\x1f) delimited so a subject containing tabs or spaces
// can't corrupt the split.
export function commitInfoArgs(ref) {
  return ['log', '-1', '--no-color', '--pretty=format:%H%x1f%s%x1f%cs', ref];
}
export function parseCommitInfo(out) {
  const s = String(out ?? '');
  if (!s) return null;
  const [sha = '', subject = '', date = ''] = s.split('\x1f');
  return { sha, subject, date };
}
// Combine the reviewed-ref commit with its <remote>/<branch> counterpart, dropping the origin
// block when it matches — the normal case, since the reviewed ref usually IS <remote>/<branch>.
// Only when they diverge (e.g. checkout fell back to a bare local branch behind origin) is
// origin carried, so the report can show what the branch reviewed vs what origin actually has.
// Pure — takes the two parsed infos so it is unit-testable.
export function commitSide(branch, ref, info, originInfo) {
  if (!info) return null;
  const origin = (originInfo && originInfo.sha && originInfo.sha !== info.sha) ? originInfo : null;
  return { branch, ref, sha: info.sha, subject: info.subject, date: info.date, origin };
}

// resolve the ref that actually exists: prefer <remote>/<branch>, else the bare branch.
function resolveRef(remote, branch) {
  for (const ref of [`${remote}/${branch}`, branch]) {
    if (tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
  }
  return null;
}
// The ref to put HEAD back on afterwards: the current branch name, else (already detached) the sha.
function currentRef() {
  return tryGit(['symbolic-ref', '--short', '-q', 'HEAD']) || tryGit(['rev-parse', 'HEAD']) || null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const sub = process.argv[2];
  const out = {};
  try {
    if (sub === 'setup') {
      const base = arg('--base');
      const head = arg('--head');
      const remote = arg('--remote', 'origin');
      const prNumber = arg('--pr');
      const notes = [];
      if (!base || !head) { console.error('checkout.mjs setup: --base and --head are required'); process.exit(2); }

      if (tryGit(fetchArgs(remote, base, head)) === null) notes.push(`could not fetch ${base}/${head} from ${remote} — using local refs`);

      const headRef = resolveRef(remote, head);
      const baseRef = resolveRef(remote, base);
      if (!headRef) { console.error(`checkout.mjs setup: cannot resolve head ref for "${head}"`); process.exit(3); }
      if (!baseRef) notes.push(`cannot resolve base ref for "${base}" — diff range may be wrong`);

      const sha = tryGit(['rev-parse', headRef]) ?? '';
      const originalRef = currentRef(); // capture BEFORE moving HEAD so teardown can restore it

      // Base/target commit facts for the report header (branch, sha, subject, date), each with
      // its <remote>/<branch> counterpart carried only when it diverges from the reviewed ref.
      const headCommit = commitSide(head, headRef, parseCommitInfo(tryGit(commitInfoArgs(headRef))), parseCommitInfo(tryGit(commitInfoArgs(`${remote}/${head}`))));
      const baseCommit = baseRef ? commitSide(base, baseRef, parseCommitInfo(tryGit(commitInfoArgs(baseRef))), parseCommitInfo(tryGit(commitInfoArgs(`${remote}/${base}`)))) : null;

      // Fork point (merge-base) = the reviewed diff base, so the range is the GitHub three-dot
      // `base...head` — identical hashes to the PR's Files-changed tab even if base advanced. Null
      // (unrelated histories / shallow clone) falls back downstream to the baseRef tip with a note.
      const baseSha = baseRef ? tryGit(mergeBaseArgs(baseRef, headRef)) : null;
      if (baseRef && !baseSha) notes.push(`could not compute merge-base of ${baseRef} and ${headRef} (unrelated histories or shallow clone) — reviewing two-dot ${baseRef}..${headRef} instead of the GitHub three-dot range`);

      // Is the head behind its base? With the three-dot fork-point diff the reviewed patch is already
      // GitHub-exact (no phantom deletions), but the PR still hasn't integrated base's newer commits —
      // a real merge/semantic-conflict risk — so surface it for the human, advisory only.
      let behindBase = null;
      if (baseRef) {
        const log = tryGit(commitsBehindArgs(headRef, baseRef));
        if (log !== null) {
          behindBase = parseCommits(log);
          if (behindBase.count > 0) notes.push(`head is behind ${baseRef} by ${behindBase.count} commit(s); the reviewed diff is GitHub-exact (three-dot from the fork point) but the branch has not integrated ${base}'s newer commits — a merge/semantic-conflict risk, consider rebasing`);
        }
      }

      // Detach onto the latest pushed head. git refuses if uncommitted tracked changes would be
      // overwritten — that is the "stash it yourself" case: surface git's own message and bail.
      try {
        sh(checkoutDetachArgs(headRef));
      } catch (e) {
        const detail = String(e.stderr ?? e.message ?? '').trim();
        console.error(
          `checkout.mjs setup: cannot check out ${headRef} — your working tree has changes git would overwrite.\n` +
          `Stash or commit them yourself, then re-run the review:\n` +
          `  git stash    # or: git commit\n` +
          (detail ? `\ngit said:\n${detail}\n` : ''),
        );
        process.exit(4);
      }

      Object.assign(out, {
        ok: true, remote, base, head, prNumber: prNumber ?? null,
        // baseRef = branch tip (report header); baseSha = fork point (the diff base the command
        // feeds to plan/gather/capture-diff so the reviewed range is GitHub-exact three-dot).
        baseRef, baseSha, headRef, sha, originalRef,
        baseCommit, headCommit,
        range: baseSha ? `${baseSha}..${headRef}` : (baseRef ? rangeFor(baseRef, headRef) : null),
        behindBase, notes,
      });
    } else if (sub === 'forkpoint') {
      // Compute the reviewed diff base WITHOUT touching HEAD or fetching — for the --no-checkout
      // path (e.g. an already-detached worktree, or an in-place local review) that still wants the
      // GitHub-exact three-dot range. Prints baseSha = merge-base(base, head); head defaults to HEAD.
      const base = arg('--base');
      const remote = arg('--remote', 'origin');
      const headArg = arg('--head', 'HEAD');
      const notes = [];
      if (!base) { console.error('checkout.mjs forkpoint: --base is required'); process.exit(2); }
      const baseRef = resolveRef(remote, base) ?? base;
      const headRef = (headArg === 'HEAD') ? 'HEAD' : (resolveRef(remote, headArg) ?? headArg);
      const baseSha = tryGit(mergeBaseArgs(baseRef, headRef));
      if (!baseSha) notes.push(`could not compute merge-base of ${baseRef} and ${headRef} — falling back to ${baseRef} (two-dot)`);
      Object.assign(out, { ok: !!baseSha, baseRef, headRef, baseSha, notes });
    } else if (sub === 'restore') {
      const ref = arg('--ref');
      if (!ref) { console.error('checkout.mjs restore: --ref is required'); process.exit(2); }
      const restored = tryGit(restoreArgs(ref)) !== null;
      Object.assign(out, { ok: restored, ref, restored });
    } else {
      console.error('checkout.mjs: first arg must be "setup", "forkpoint", or "restore"');
      process.exit(2);
    }
  } catch (e) {
    console.error(`checkout.mjs: ${e.message}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
