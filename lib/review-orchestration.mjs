// Pure: helpers for the review Workflow (lib/review-workflow.mjs). Kept here so they
// are importable + unit-testable; the Workflow DSL file inlines copies because the
// Workflow sandbox has no module/filesystem access. Keep the two in sync.

// One review aspect per (dimension × shard). More aspects, never nested agents.
// Dimensions in `unsharded` get a SINGLE aspect over all changed files instead of one
// per shard — used for cross-file dimensions (D3 security) that already consume the full
// diff regardless of shard, so sharding them only multiplies the full-diff token cost.
export function expandAspects(dimensionAgents = {}, shards = [], { unsharded = [] } = {}) {
  const list = shards.length ? shards : [{ label: 'all', files: [] }];
  const whole = list.flatMap((s) => s.files ?? []);
  const single = new Set(unsharded);
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    if (single.has(dim)) { out.push({ dim, agent, shardId: 'all', files: whole }); continue; }
    for (const s of list) out.push({ dim, agent, shardId: s.label, files: s.files ?? [] });
  }
  return out;
}

// Line-sensitive dedup key. Deliberately NOT memory.findingKey (which is line-insensitive
// for cross-run matching) — here two same-title findings at different lines are distinct.
export function findingKey(f = {}) {
  return `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
}

// Per-aspect dispatch counters (the <=N-subagents-per-aspect cap, decided in code).
export function newCaps() { return {}; }
export function canSpawn(caps, key, max = 3) { return (caps[key] ?? 0) < max; }
export function recordSpawn(caps, key) { caps[key] = (caps[key] ?? 0) + 1; }

// Bundled agents register under the plugin namespace on EVERY install
// (`adversarial-code-review:<name>`). A bare name only resolves when a same-named
// user/project agent happens to exist locally, so dispatching by bare name works on
// the plugin's own repo but throws "agent type not found" on other projects. Resolve
// every plugin agent through here. Built-in harness agents (general-purpose) and
// already-namespaced ids pass through untouched; the result is idempotent.
export const PLUGIN_NS = 'adversarial-code-review';
export function pluginAgent(type) {
  if (!type || type === 'general-purpose' || type.includes(':')) return type;
  return `${PLUGIN_NS}:${type}`;
}

// Assemble the exact report.mjs stdin object. Throws if plan/agentRuns are missing so the
// Workflow fails before spawning the report agent (report.mjs enforces the same invariant).
export function buildReportPayload(pieces = {}) {
  if (!pieces.plan) throw new Error('buildReportPayload: plan is required');
  if (!pieces.agentRuns) throw new Error('buildReportPayload: agentRuns is required');
  const { plan } = pieces;
  return {
    findings: pieces.findings ?? [],
    criteria: pieces.criteria ?? [],
    tier: plan.tier,
    gate: plan.gate,
    needsHuman: pieces.needsHuman ?? [],
    skipped: pieces.skipped ?? [],
    strengths: pieces.strengths ?? [],
    summary: pieces.summary ?? '',
    summaryPoints: pieces.summaryPoints ?? [],
    context: pieces.context ?? {},
    verify: pieces.verifySummary ?? {},
    plan,
    agentRuns: pieces.agentRuns,
    commentMode: pieces.commentMode === true,
    startedAt: pieces.startedAt ?? null,
    prNumber: pieces.prNumber ?? null,
    checkout: pieces.checkout ?? null,
    learningStore: plan.learning?.store ?? null,
    range: plan.range ?? null,
  };
}
