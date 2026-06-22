import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOOK = new URL('../.claude/hooks/syntax-check.mjs', import.meta.url).pathname;
const runHook = (file) => spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ tool_input: { file_path: file } }), encoding: 'utf8',
});
const tmp = (name, src) => { const f = join(mkdtempSync(join(tmpdir(), 'acr-')), name); writeFileSync(f, src); return f; };

test('valid workflow-DSL file (top-level return) passes', () => {
  const f = tmp('x-workflow.mjs', `export const meta = { name: 'x' };\nphase('a');\nconst A = JSON.parse(args);\nreturn { ok: A };\n`);
  assert.equal(runHook(f).status, 0);
});

test('broken workflow-DSL file still fails', () => {
  const f = tmp('y-workflow.mjs', `export const meta = { name: 'y' };\nconst = ;\nreturn 1;\n`);
  assert.equal(runHook(f).status, 2);
});

test('normal .mjs still syntax-checked', () => {
  assert.equal(runHook(tmp('ok.mjs', 'export const a = 1;\n')).status, 0);
  assert.equal(runHook(tmp('bad.mjs', 'export const = ;\n')).status, 2);
});
