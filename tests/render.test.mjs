import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReport, renderVerdict } from '../lib/render.mjs';

const findings = [
  { dimension: 'D3', severity: 'critical', file: 'src/auth.ts', line: 42, title: 'Missing authz', confidence: 95, evidence: 'no role check', fix: 'add requirePermission' },
  { dimension: 'D2', severity: 'minor', file: 'src/util.ts', line: 7, title: 'Magic number', confidence: 82, evidence: '', fix: 'name the constant' },
];
const criteria = [{ id: 'AC1', text: 'only admins can delete', covered: true, evidence: 'auth.test.ts:10' }];

test('verdict blocks on critical', () => {
  const v = renderVerdict(findings, { block_on: ['critical'], warn_on: ['high'] });
  assert.equal(v.verdict, 'BLOCK');
  assert.equal(v.exitCode, 1);
});

test('report groups by severity and includes traceability matrix', () => {
  const md = renderReport({ findings, criteria, tier: 'critical' });
  assert.match(md, /## Critical/);
  assert.match(md, /Missing authz/);
  assert.match(md, /AC1/);
  assert.match(md, /only admins can delete/);
});

test('only confidence>=80 findings are rendered', () => {
  const noisy = [...findings, { dimension: 'D2', severity: 'minor', file: 'x', line: 1, title: 'low conf', confidence: 50 }];
  const md = renderReport({ findings: noisy, criteria, tier: 'standard' });
  assert.doesNotMatch(md, /low conf/);
});
