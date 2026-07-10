// Lazily loads shared config once and caches it in module state.
let cache = null;

export async function getConfig(fetchConfig) {
  if (!cache) {
    cache = await fetchConfig(); // two concurrent callers both see cache===null and both fetch/write
  }
  return cache;
}

export function resetConfigCache() {
  cache = null;
}
