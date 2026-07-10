import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLearnings, migrateLearnings, EMPTY, findingKey } from '../lib/memory.mjs';

let dir;
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acr-memory-v2-')); });
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('EMPTY is v2', () => {
  assert.equal(EMPTY.version, 2);
});

test('migrateLearnings upgrades a v1-shaped object to v2, preserving every v1 field', () => {
  const v1 = {
    version: 1,
    acceptedFalsePositives: [{ key: 'a.ts::noise', note: 'known FP' }],
    recurring: [{ key: 'b.ts::real', count: 3 }],
    unresolved: [{ question: 'is this intentional?', file: 'c.ts' }],
  };
  const v2 = migrateLearnings(v1);
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.acceptedFalsePositives, v1.acceptedFalsePositives);
  assert.deepEqual(v2.recurring, v1.recurring);
  assert.deepEqual(v2.unresolved, v1.unresolved);
});

test('migrateLearnings is a no-op pass-through for an already-v2 object', () => {
  const v2in = { ...EMPTY };
  assert.deepEqual(migrateLearnings(v2in), v2in);
});

test('loadLearnings reads a v1 file on disk and migrates it in-memory (v1 files must still load)', () => {
  const path = join(dir, 'learnings.json');
  const v1 = {
    version: 1,
    acceptedFalsePositives: [{ key: findingKey({ file: 'a.ts', title: 'noise' }), note: 'known FP' }],
    recurring: [],
    unresolved: [],
  };
  writeFileSync(path, JSON.stringify(v1));
  const loaded = loadLearnings(path);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.acceptedFalsePositives, v1.acceptedFalsePositives);
});

test('loadLearnings tolerates unknown keys from an old file shape without erroring', () => {
  const path = join(dir, 'learnings.json');
  writeFileSync(path, JSON.stringify({ ...EMPTY, confirmedPatterns: [{ key: 'a.ts::x', count: 4 }] }));
  const loaded = loadLearnings(path);
  assert.equal(loaded.version, 2);
  assert.deepEqual(loaded.acceptedFalsePositives, []);
});

test('loadLearnings degrades to a fresh v2 EMPTY on missing/corrupt files', () => {
  assert.deepEqual(loadLearnings(join(dir, 'missing.json')), EMPTY);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(loadLearnings(bad), EMPTY);
});
