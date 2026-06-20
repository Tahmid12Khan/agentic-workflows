// Pure: split a large change into coherent review shards so reviewers never
// get a packet too big to reason about. No nested-agent magic — each shard is
// an independent review unit the orchestrator fans out by (dimension × shard).

export function shouldShard(netLoc, fileCount, threshold = 600) {
  return netLoc > threshold || fileCount > 40;
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
