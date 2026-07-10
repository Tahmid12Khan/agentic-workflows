import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchArgs, checkoutDetachArgs, restoreArgs, rangeFor, mergeBaseArgs, commitsBehindArgs, parseCommits, commitInfoArgs, parseCommitInfo, commitSide } from '../lib/checkout.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHECKOUT = new URL('../lib/checkout.mjs', import.meta.url).pathname;

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

test('mergeBaseArgs asks git for the fork point of base+head (three-dot base)', () => {
  assert.deepEqual(mergeBaseArgs('origin/main', 'origin/feature'), ['merge-base', 'origin/main', 'origin/feature']);
});

// The whole point of the fork-point base: when base advances past the fork, forkpoint returns the
// SHARED ancestor (GitHub three-dot), NOT the base tip — so the review never sees base's new commits.
test('forkpoint returns the merge-base sha even when base moved ahead of the fork', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-fp-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), '1\n'); git('add', '.'); git('commit', '-qm', 'base0');
  const forkSha = git('rev-parse', 'HEAD');
  // feature branches off the fork
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'b.txt'), 'x\n'); git('add', '.'); git('commit', '-qm', 'feat1');
  // base advances AFTER the fork
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), '2\n'); git('add', '.'); git('commit', '-qm', 'base1');
  git('checkout', '-q', 'feature');

  const r = spawnSync(process.execPath, [CHECKOUT, 'forkpoint', '--base', 'main', '--head', 'HEAD'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.baseSha, forkSha); // the fork point, NOT main's advanced tip
});

test('forkpoint exits 2 without --base', () => {
  const r = spawnSync(process.execPath, [CHECKOUT, 'forkpoint'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /base/i);
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

// --- setup e2e: the "never lose work" guarantee, exercised against a real repo + bare remote ---

test('checkout.mjs setup: fetches, detaches onto <remote>/<head>, computes the fork point; restore returns to the original ref', () => {
  const remoteDir = mkdtempSync(join(tmpdir(), 'acr-remote-'));
  const workDir = mkdtempSync(join(tmpdir(), 'acr-work-'));
  const git = (...a) => execFileSync('git', a, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteDir, stdio: ['pipe', 'pipe', 'pipe'] });

    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(workDir, 'a.txt'), '1\n');
    git('add', '.'); git('commit', '-qm', 'base');
    git('remote', 'add', 'origin', remoteDir);
    git('push', '-q', 'origin', 'main');
    const forkSha = git('rev-parse', 'HEAD');

    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(workDir, 'b.txt'), 'x\n');
    git('add', '.'); git('commit', '-qm', 'feat1');
    git('push', '-q', 'origin', 'feature');
    const featSha = git('rev-parse', 'HEAD');

    git('checkout', '-q', 'main'); // the ref in place BEFORE setup runs — restore must land back here

    const r = spawnSync(process.execPath, [CHECKOUT, 'setup', '--base', 'main', '--head', 'feature', '--remote', 'origin'], { cwd: workDir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.sha, featSha);
    assert.equal(out.baseSha, forkSha, 'baseSha is the merge-base fork point');
    assert.equal(out.originalRef, 'main');
    assert.equal(out.headRef, 'origin/feature');

    // HEAD is now detached exactly at the resolved head sha
    assert.equal(git('rev-parse', 'HEAD'), featSha);
    const symbolic = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: workDir });
    assert.notEqual(symbolic.status, 0, 'HEAD must be detached, not on a branch');

    // restore checks the recorded original ref back out
    const rr = spawnSync(process.execPath, [CHECKOUT, 'restore', '--ref', out.originalRef], { cwd: workDir, encoding: 'utf8' });
    assert.equal(rr.status, 0, rr.stderr);
    assert.equal(JSON.parse(rr.stdout).restored, true);
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('checkout.mjs setup: refuses on a dirty working tree (exit 4), never stashes — nothing is lost', () => {
  const remoteDir = mkdtempSync(join(tmpdir(), 'acr-remote-dirty-'));
  const workDir = mkdtempSync(join(tmpdir(), 'acr-work-dirty-'));
  const git = (...a) => execFileSync('git', a, { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  try {
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remoteDir, stdio: ['pipe', 'pipe', 'pipe'] });

    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    writeFileSync(join(workDir, 'a.txt'), '1\n');
    git('add', '.'); git('commit', '-qm', 'base');
    git('remote', 'add', 'origin', remoteDir);
    git('push', '-q', 'origin', 'main');

    // feature changes a.txt, so detaching onto it would overwrite an uncommitted local edit
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(workDir, 'a.txt'), '2\n');
    git('add', '.'); git('commit', '-qm', 'feat1');
    git('push', '-q', 'origin', 'feature');

    git('checkout', '-q', 'main');
    writeFileSync(join(workDir, 'a.txt'), 'DIRTY UNCOMMITTED\n'); // dirty the tracked file, never committed

    const r = spawnSync(process.execPath, [CHECKOUT, 'setup', '--base', 'main', '--head', 'feature', '--remote', 'origin'], { cwd: workDir, encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /working tree has changes/i);
    assert.match(r.stderr, /stash/i);

    // never stashed, never lost: the dirty content is still right there
    assert.equal(readFileSync(join(workDir, 'a.txt'), 'utf8'), 'DIRTY UNCOMMITTED\n');
    // HEAD never moved
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
  } finally {
    rmSync(remoteDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
