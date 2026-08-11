import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldFunnel, classifyFiles, sampleCluster, funnelFiles } from '../lib/funnel.mjs';

// --- activation threshold ---
test('shouldFunnel only engages above the threshold; 0/negative disables it', () => {
  assert.equal(shouldFunnel(250, 250), false);   // AT the threshold does not engage
  assert.equal(shouldFunnel(251, 250), true);
  assert.equal(shouldFunnel(1000, 0), false);    // 0 → disabled
  assert.equal(shouldFunnel(1000, -1), false);
});

// --- classification ---
test('classifyFiles: a risk-path file is always hot, even inside an otherwise-mechanical cluster', () => {
  const files = [
    ...Array.from({ length: 9 }, (_, i) => `gen/file${i}.js`),
    'gen/auth-helper.js', // shares dir+ext with the cluster above, but matches the "auth" risk path
  ];
  const locByFile = new Map(files.map((f) => [f, 10])); // uniform churn — would otherwise qualify as mechanical
  const { hot, clusters } = classifyFiles(files, { riskPaths: ['auth'], locByFile, clusterMin: 8, churnTolerance: 0.3 });
  assert.ok(hot.includes('gen/auth-helper.js'));
  // the risk file must NOT appear inside the mechanical cluster
  for (const c of clusters) assert.ok(!c.files.includes('gen/auth-helper.js'));
});

test('classifyFiles: a group below cluster_min stays entirely hot (not sampled)', () => {
  const files = Array.from({ length: 5 }, (_, i) => `pkg/file${i}.js`); // only 5 < cluster_min 8
  const locByFile = new Map(files.map((f) => [f, 10]));
  const { hot, clusters } = classifyFiles(files, { locByFile, clusterMin: 8, churnTolerance: 0.3 });
  assert.deepEqual(new Set(hot), new Set(files));
  assert.equal(clusters.length, 0);
});

test('classifyFiles: high-variance churn disqualifies a group from being mechanical', () => {
  const files = Array.from({ length: 10 }, (_, i) => `pkg/file${i}.js`);
  const locByFile = new Map(files.map((f, i) => [f, i === 0 ? 500 : 10])); // one huge outlier
  const { hot, clusters } = classifyFiles(files, { locByFile, clusterMin: 8, churnTolerance: 0.3 });
  assert.equal(clusters.length, 0, 'high variance must disqualify the whole group');
  assert.deepEqual(new Set(hot), new Set(files));
});

test('classifyFiles: low-variance churn qualifies a group as a mechanical cluster', () => {
  const files = Array.from({ length: 10 }, (_, i) => `pkg/file${i}.js`);
  // churn within +-30% of median (10): 7..13 all qualify
  const locByFile = new Map(files.map((f, i) => [f, 10 + (i % 4) - 1])); // 9,10,11,12 range roughly
  const { hot, clusters } = classifyFiles(files, { locByFile, clusterMin: 8, churnTolerance: 0.3 });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].files.length, 10);
  assert.equal(hot.length, 0);
});

test('classifyFiles: groups by top-level directory AND extension separately', () => {
  const jsFiles = Array.from({ length: 8 }, (_, i) => `pkg/file${i}.js`);
  const tsFiles = Array.from({ length: 8 }, (_, i) => `pkg/file${i}.ts`);
  const locByFile = new Map([...jsFiles, ...tsFiles].map((f) => [f, 10]));
  const { clusters } = classifyFiles([...jsFiles, ...tsFiles], { locByFile, clusterMin: 8, churnTolerance: 0.3 });
  assert.equal(clusters.length, 2, 'same dir, different extension → two separate groups');
});

// --- sampling ---
test('sampleCluster always includes the single highest-churn file', () => {
  const files = Array.from({ length: 20 }, (_, i) => `pkg/f${i}.js`);
  const locByFile = new Map(files.map((f, i) => [f, i]));
  locByFile.set('pkg/f7.js', 999); // clear highest
  const { sampled } = sampleCluster({ files }, { locByFile, clusterMinSample: 3, sampleRate: 0.15 });
  assert.ok(sampled.includes('pkg/f7.js'));
});

test('sampleCluster respects cluster_min_sample and sample_rate, and partitions sampled/skipped exactly', () => {
  const files = Array.from({ length: 40 }, (_, i) => `pkg/f${i}.js`);
  const locByFile = new Map(files.map((f, i) => [f, i]));
  const { sampled, skipped } = sampleCluster({ files }, { locByFile, clusterMinSample: 3, sampleRate: 0.15 });
  // target = max(3, ceil(40*0.15)) = max(3, 6) = 6
  assert.equal(sampled.length, 6);
  assert.equal(skipped.length, 34);
  assert.deepEqual(new Set([...sampled, ...skipped]), new Set(files));
});

test('sampleCluster: deterministic — identical input yields identical output across repeated calls', () => {
  const files = Array.from({ length: 50 }, (_, i) => `pkg/dir${i % 5}/f${i}.rb`);
  const locByFile = new Map(files.map((f, i) => [f, (i * 37) % 23]));
  const a = sampleCluster({ files }, { locByFile, clusterMinSample: 3, sampleRate: 0.15 });
  const b = sampleCluster({ files }, { locByFile, clusterMinSample: 3, sampleRate: 0.15 });
  assert.deepEqual(a, b);
});

test('sampleCluster: never samples more than the cluster has', () => {
  const files = ['a.js', 'b.js'];
  const locByFile = new Map([['a.js', 5], ['b.js', 1]]);
  const { sampled, skipped } = sampleCluster({ files }, { locByFile, clusterMinSample: 3, sampleRate: 0.15 });
  assert.equal(sampled.length, 2);
  assert.equal(skipped.length, 0);
});

// --- end-to-end funnel ---
test('funnelFiles: deterministic end to end — repeated calls on the same input match exactly', () => {
  const mechanical = Array.from({ length: 100 }, (_, i) => `gen/f${i}.py`);
  const hotFiles = Array.from({ length: 20 }, (_, i) => `svc${i}/main.go`); // 20 distinct dirs, never cluster
  const locByFile = new Map([...mechanical.map((f, i) => [f, 10 + (i % 3)]), ...hotFiles.map((f) => [f, 50])]);
  const opts = { riskPaths: ['auth'], locByFile, threshold: 100, clusterMin: 8, churnTolerance: 0.3, sampleRate: 0.15, clusterMinSample: 3 };
  const a = funnelFiles([...mechanical, ...hotFiles], opts);
  const b = funnelFiles([...mechanical, ...hotFiles], opts);
  assert.deepEqual(a, b);
});

test('funnelFiles: hot files fully reviewed, mechanical cluster sampled, nothing silently unaccounted for', () => {
  const mechanical = Array.from({ length: 100 }, (_, i) => `gen/f${i}.py`);
  const hotFiles = Array.from({ length: 20 }, (_, i) => `svc${i}/main.go`);
  const locByFile = new Map([...mechanical.map((f, i) => [f, 10 + (i % 3)]), ...hotFiles.map((f) => [f, 50])]);
  const result = funnelFiles([...mechanical, ...hotFiles], {
    riskPaths: [], locByFile, threshold: 100, clusterMin: 8, churnTolerance: 0.3, sampleRate: 0.15, clusterMinSample: 3,
  });
  assert.equal(result.summary.hot, 20);
  assert.equal(result.summary.mechanicalClusters, 1);
  assert.equal(result.summary.mechanicalTotal, 100);
  assert.equal(result.summary.sampled, 15); // max(3, ceil(100*0.15)) = 15
  assert.equal(result.summary.skippedTotal, 85);
  assert.equal(result.summary.reviewed, 35); // 20 hot + 15 sampled
  assert.equal(result.files.length, 35);
  // every hot file made it into the reviewed set
  for (const f of hotFiles) assert.ok(result.files.includes(f));
  // cluster summary accounts for every mechanical file (sampled + skipped == total) — no silent drop
  assert.equal(result.summary.clusters.length, 1);
  const c = result.summary.clusters[0];
  assert.equal(c.sampled + c.skipped, c.total);
  assert.equal(c.total, 100);
});

test('funnelFiles: no qualifying mechanical cluster → everything stays hot (funnel is a conservative no-op)', () => {
  // 300 files, all in distinct top-level dirs — none form a group >= cluster_min
  const files = Array.from({ length: 300 }, (_, i) => `dir${i}/file.js`);
  const locByFile = new Map(files.map((f) => [f, 10]));
  const result = funnelFiles(files, { locByFile, threshold: 250, clusterMin: 8, churnTolerance: 0.3, sampleRate: 0.15, clusterMinSample: 3 });
  assert.equal(result.summary.mechanicalClusters, 0);
  assert.equal(result.summary.hot, 300);
  assert.equal(result.files.length, 300);
});
