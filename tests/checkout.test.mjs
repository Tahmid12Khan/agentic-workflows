import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArgs, checkoutDetachArgs, restoreArgs, rangeFor, commitsBehindArgs, parseCommits } from '../lib/checkout.mjs';

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
