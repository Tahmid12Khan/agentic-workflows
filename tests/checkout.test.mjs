import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArgs, checkoutDetachArgs, restoreArgs, rangeFor, commitsBehindArgs, parseCommits, commitInfoArgs, parseCommitInfo, commitSide } from '../lib/checkout.mjs';

test('fetchArgs fetches base+head from the remote, no tags', () => {
  assert.deepEqual(fetchArgs('origin', 'main', 'feature'), ['fetch', '--no-tags', 'origin', 'main', 'feature']);
  // omits falsy refs
  assert.deepEqual(fetchArgs('upstream', 'main', undefined), ['fetch', '--no-tags', 'upstream', 'main']);
});

test('checkoutDetachArgs detaches HEAD onto the resolved head ref', () => {
  assert.deepEqual(checkoutDetachArgs('origin/feature'), ['checkout', '--detach', 'origin/feature']);
});

test('restoreArgs checks the original ref back out (branch name or sha)', () => {
  assert.deepEqual(restoreArgs('feature/login'), ['checkout', 'feature/login']);
  assert.deepEqual(restoreArgs('abcdef1'), ['checkout', 'abcdef1']);
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

test('commitInfoArgs asks git for one commit: sha, subject, date, unit-separated', () => {
  assert.deepEqual(commitInfoArgs('origin/main'),
    ['log', '-1', '--no-color', '--pretty=format:%H%x1f%s%x1f%cs', 'origin/main']);
});

test('parseCommitInfo splits the unit-separated commit line; empty → null', () => {
  assert.deepEqual(parseCommitInfo('abc123\x1ffix: bug\x1f2026-07-02'),
    { sha: 'abc123', subject: 'fix: bug', date: '2026-07-02' });
  assert.equal(parseCommitInfo(''), null);
  assert.equal(parseCommitInfo(null), null);
  // a subject may itself contain spaces/tabs — only the \x1f delimiters split
  assert.deepEqual(parseCommitInfo('h\x1ffeat: a\tb c\x1f2026-01-01'),
    { sha: 'h', subject: 'feat: a\tb c', date: '2026-01-01' });
});

test('commitSide carries origin only when it diverges from the reviewed commit', () => {
  const info = { sha: 'aaaa', subject: 's', date: 'd' };
  // same sha on origin → origin dropped (the normal case: reviewed ref IS <remote>/<branch>)
  assert.deepEqual(commitSide('main', 'origin/main', info, { sha: 'aaaa', subject: 's', date: 'd' }),
    { branch: 'main', ref: 'origin/main', sha: 'aaaa', subject: 's', date: 'd', origin: null });
  // diverged → origin carried so the report can show reviewed vs what origin has
  const div = commitSide('main', 'main', info, { sha: 'bbbb', subject: 's2', date: 'd2' });
  assert.deepEqual(div.origin, { sha: 'bbbb', subject: 's2', date: 'd2' });
  // no reviewed info → null side (base ref could not be resolved)
  assert.equal(commitSide('main', 'main', null, { sha: 'x' }), null);
});
