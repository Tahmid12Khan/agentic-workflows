import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('project config is valid JSON and has a gate', () => {
  const cfg = JSON.parse(readFileSync('.review/config.json', 'utf8'));
  assert.ok(cfg.gate.block_on.includes('critical'));
  assert.ok(Array.isArray(cfg.risk_map.critical));
});

// Guards the A4-class regression: a config key absent from the schema (e.g. a
// removed knob left in the scaffold) would fail /review-init's own validation.
test('project config has no keys the schema forbids (additionalProperties:false blocks)', () => {
  const cfg = JSON.parse(readFileSync('.review/config.json', 'utf8'));
  const schema = JSON.parse(readFileSync('.review/config.schema.json', 'utf8'));
  const errors = [];
  (function check(obj, sch, path) {
    if (!sch || typeof obj !== 'object' || obj === null || Array.isArray(obj)) return;
    const props = sch.properties ?? {};
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errors.push(`${path}${k}`);
    }
    for (const k of Object.keys(obj)) if (props[k]) check(obj[k], props[k], `${path}${k}.`);
  })(cfg, schema, '');
  assert.deepEqual(errors, [], `unknown config keys: ${errors.join(', ')}`);
});
