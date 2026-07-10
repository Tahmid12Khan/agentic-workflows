// WS1 unit tests: the review-doctrine mapping (lib/doctrine.mjs) + the deterministic change-size
// process advisory (lib/signals.mjs changeSizingAdvisory). Pure, no deps, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { doctrineFiles, doctrineMap, DOCTRINE_FILES, DOCTRINE_DIR } from '../lib/doctrine.mjs';
import { changeSizingAdvisory } from '../lib/signals.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

test('doctrine: every mapped fragment names a real shipped file under agents/doctrine/', () => {
  for (const f of DOCTRINE_FILES) {
    assert.ok(existsSync(join(ROOT, DOCTRINE_DIR, f)), `${f} exists`);
  }
  // and the mapping only ever names files in DOCTRINE_FILES
  for (const tier of ['standard', 'high', 'critical']) {
    for (const files of Object.values(doctrineMap(tier))) {
      for (const f of files) assert.ok(DOCTRINE_FILES.includes(f), `${f} is a known fragment`);
    }
  }
});

test('doctrine: mapping is per-agent and <= 2 fragments each', () => {
  assert.deepEqual(doctrineFiles('correctness-reviewer', 'standard'), ['severity-norms.md', 'change-sizing.md']);
  assert.deepEqual(doctrineFiles('simplification-reviewer', 'standard'), ['structural-remedies.md', 'complexity-judgment.md']);
  assert.deepEqual(doctrineFiles('type-design-reviewer', 'standard'), ['complexity-judgment.md']);
  // no reviewer exceeds the 2-fragment token budget
  for (const files of Object.values(doctrineMap('critical'))) assert.ok(files.length <= 2);
});

test('doctrine: an unmapped agent gets nothing (never an empty read)', () => {
  assert.deepEqual(doctrineFiles('vuln-reviewer', 'high'), []);
  assert.deepEqual(doctrineFiles('data-store-reviewer', 'critical'), []);
});

test('doctrine: tier gating — trivial/low get no doctrine, standard+ do', () => {
  assert.deepEqual(doctrineFiles('correctness-reviewer', 'trivial'), []);
  assert.deepEqual(doctrineFiles('correctness-reviewer', 'low'), []);
  assert.deepEqual(doctrineMap('trivial'), {});
  assert.deepEqual(doctrineMap('low'), {});
  assert.ok(Object.keys(doctrineMap('standard')).length >= 3);
  assert.ok(Object.keys(doctrineMap('high')).length >= 3);
});

test('change-sizing: below the soft threshold → no advisory', () => {
  assert.deepEqual(changeSizingAdvisory({ added: 120, deleted: 80, fileCount: 4 }), []); // 200 changed
});

test('change-sizing: soft threshold (>= 400) → one suggestion advisory', () => {
  const a = changeSizingAdvisory({ added: 300, deleted: 150, fileCount: 6 }); // 450 changed
  assert.equal(a.length, 1);
  assert.equal(a[0].severity, 'suggestion');
  assert.equal(a[0].kind, 'change-size');
  assert.match(a[0].message, /one logical change/i);
});

test('change-sizing: hard threshold (>= 1000) → split advisory', () => {
  const a = changeSizingAdvisory({ added: 700, deleted: 500, fileCount: 20 }); // 1200 changed
  assert.equal(a.length, 1);
  assert.match(a[0].message, /should be split/i);
});

test('change-sizing: pure deletion is exempt even when huge', () => {
  assert.deepEqual(changeSizingAdvisory({ added: 0, deleted: 5000, fileCount: 30 }), []);
});

test('change-sizing: a change that is mostly renames is exempt (mechanical)', () => {
  // 40 files, all renames → mechanical; even a big churn does not trigger it
  assert.deepEqual(changeSizingAdvisory({ added: 600, deleted: 600, fileCount: 40, renames: 40 }), []);
  // but real edits alongside a few renames still trigger it
  assert.equal(changeSizingAdvisory({ added: 600, deleted: 600, fileCount: 40, renames: 3 }).length, 1);
});
