// Pure: split a large change into coherent review shards so reviewers never
// get a packet too big to reason about. No nested-agent magic — each shard is
// an independent review unit the orchestrator fans out by (dimension × shard).

export function shouldShard(netLoc, fileCount, threshold = 600) {
  return netLoc > threshold || fileCount > 40;
}

// Bound the shard count so the review fan-out (≈ shardedAgents × shards, since D3/vuln is unsharded)
// stays under maxAspects. On a big heterogeneous diff many content-gated dimensions activate, so
// shardedAgents can be ~10; a flat 4-shard split then fans out ~40 reviewer agents — each an API call,
// which widens the transient-overload (529) window and multiplies cost/latency. Reducing shards keeps
// EVERY dimension running (no coverage dropped) over fewer, larger per-agent slices. Deterministic;
// always ≥ 1. maxAspects ≤ 0 is treated as "no ceiling" (returns configMax).
export function cappedMaxShards(configMax = 4, shardedAgents = 1, maxAspects = 40) {
  const cfg = Math.max(1, Math.floor(configMax) || 1);
  if (!(maxAspects > 0)) return cfg;
  const byCeiling = Math.max(1, Math.floor(maxAspects / Math.max(1, shardedAgents)));
  return Math.min(cfg, byCeiling);
}

// Group files by their top-level directory, then merge the smallest groups
// together until we are at or below maxShards. Deterministic and stable.
export function shardFiles(files, { maxShards = 4 } = {}) {
  const list = (files ?? []).filter(Boolean);
  if (list.length === 0) return [];
  if (list.length === 1) return [{ label: topDir(list[0]), files: list }];

  const groups = new Map();
  for (const f of list) {
    const key = topDir(f);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  let shards = [...groups.entries()].map(([label, fs]) => ({ label, files: fs }));
  shards.sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));

  // merge the two smallest until we fit maxShards
  while (shards.length > maxShards) {
    shards.sort((a, b) => a.files.length - b.files.length || a.label.localeCompare(b.label));
    const a = shards.shift();
    const b = shards.shift();
    shards.unshift({ label: `${a.label}+${b.label}`, files: [...a.files, ...b.files] });
  }
  shards.sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));
  return shards;
}

// One shard covering everything — the non-sharded default.
export function singleShard(files) {
  return [{ label: 'all', files: files ?? [] }];
}

function topDir(f) {
  const i = f.indexOf('/');
  return i === -1 ? '(root)' : f.slice(0, i);
}
