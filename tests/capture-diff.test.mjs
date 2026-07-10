// capture-diff.mjs: the deterministic raw-diff capture that feeds buildDiffIndex + context-pack.
// Unit test on the pure argv builder + a CLI smoke that proves the output is RAW git (markers the
// downstream parsers key on), not a stat/summary rewrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffArgs } from '../lib/capture-diff.mjs';

const CAPTURE = new URL('../lib/capture-diff.mjs', import.meta.url).pathname;

test('diffArgs builds a two-dot, no-color range (head defaults to HEAD), quotepath disabled', () => {
  assert.deepEqual(diffArgs('abc'), ['-c', 'core.quotePath=false', 'diff', '--no-color', 'abc..HEAD']);
  assert.deepEqual(diffArgs('abc', 'def'), ['-c', 'core.quotePath=false', 'diff', '--no-color', 'abc..def']);
});

test('capture-diff exits 2 without --base', () => {
  const r = spawnSync(process.execPath, [CAPTURE], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /base/i);
});

test('capture-diff emits a RAW unified diff (diff --git / @@ markers intact)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-cap-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'change');

  const out = spawnSync(process.execPath, [CAPTURE, '--base', base], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0);
  // The whole point: markers at line-start, so buildDiffIndex/context-pack can parse it.
  assert.match(out.stdout, /^diff --git a\/a\.ts b\/a\.ts$/m);
  assert.match(out.stdout, /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m);
  assert.match(out.stdout, /^\+const y = 2;$/m);
});

test('capture-diff emits a non-ASCII path raw, never quoted+octal-escaped (core.quotePath=false)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'acr-cap-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.ts'), 'const x = 1;\n');
  git('add', 'a.ts');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(join(dir, 'café.ts'), 'const y = 2;\n');
  git('add', 'café.ts');
  git('commit', '-qm', 'add unicode file');

  const out = spawnSync(process.execPath, [CAPTURE, '--base', base], { cwd: dir, encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^\+\+\+ b\/café\.ts$/m);
  assert.doesNotMatch(out.stdout, /"b\/caf/);
});
