import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeRef, worktreeName, fetchArgs, addArgs, removeArgs, rangeFor, commitsBehindArgs, parseCommits } from '../lib/worktree.mjs';

test('sanitizeRef strips path separators and unsafe chars', () => {
  assert.equal(sanitizeRef('feature/login-fix'), 'feature-login-fix');
  assert.equal(sanitizeRef('feat/JIRA-12@weird~'), 'feat-JIRA-12-weird');
  assert.equal(sanitizeRef(''), 'ref');               // empty → safe fallback
  assert.equal(sanitizeRef('--lead--'), 'lead');      // trimmed
});

test('worktreeName is deterministic and encodes pr + head + short sha', () => {
  assert.equal(
    worktreeName({ head: 'feature/login', sha: 'abcdef1234567890', prNumber: 7 }),
    'review-pr-7-feature-login-abcdef12',
  );
  // no PR, no sha → still valid
  assert.equal(worktreeName({ head: 'main' }), 'review-main');
  // same inputs → same name (no Date/random)
  assert.equal(worktreeName({ head: 'x', sha: 'deadbeefcafe' }), worktreeName({ head: 'x', sha: 'deadbeefcafe' }));
});

test('fetchArgs fetches base+head from the remote, no tags', () => {
  assert.deepEqual(fetchArgs('origin', 'main', 'feature'), ['fetch', '--no-tags', 'origin', 'main', 'feature']);
  // omits falsy refs
  assert.deepEqual(fetchArgs('upstream', 'main', undefined), ['fetch', '--no-tags', 'upstream', 'main']);
});

test('addArgs creates a detached worktree at the given ref', () => {
  assert.deepEqual(addArgs('.adverserial-code-review/worktrees/review-pr-7', 'origin/feature'),
    ['worktree', 'add', '--detach', '.adverserial-code-review/worktrees/review-pr-7', 'origin/feature']);
});

test('removeArgs force-removes the worktree path', () => {
  assert.deepEqual(removeArgs('/tmp/wt'), ['worktree', 'remove', '--force', '/tmp/wt']);
});

test('rangeFor builds base..head against the resolved refs', () => {
  assert.equal(rangeFor('origin/main', 'origin/feature'), 'origin/main..origin/feature');
});

test('commitsBehindArgs lists commits in base but not in head (head..base)', () => {
  assert.deepEqual(commitsBehindArgs('origin/feature', 'origin/main'),
    ['log', '--no-color', '--pretty=format:%h%x09%s', 'origin/feature..origin/main']);
});

test('parseCommits parses tab-separated sha/subject, treats empty as not-behind, and caps the list', () => {
  const r = parseCommits('abc1234\tfix: bug\ndef5678\tfeat: thing');
  assert.equal(r.count, 2);
  assert.deepEqual(r.commits[0], { sha: 'abc1234', subject: 'fix: bug' });
  assert.equal(r.truncated, false);
  // empty log → up to date, not behind
  assert.deepEqual(parseCommits(''), { count: 0, commits: [], truncated: false });
  // count reflects all, list is capped at 20
  const many = Array.from({ length: 25 }, (_, i) => `sha${i}\ts${i}`).join('\n');
  const c = parseCommits(many);
  assert.equal(c.count, 25);
  assert.equal(c.commits.length, 20);
  assert.equal(c.truncated, true);
});
