// Pure: helpers for the review Workflow (lib/review-workflow.mjs). Kept here so they
// are importable + unit-testable; the Workflow DSL file inlines copies because the
// Workflow sandbox has no module/filesystem access. Keep the two in sync.

// One review aspect per (dimension × shard). More aspects, never nested agents.
export function expandAspects(dimensionAgents = {}, shards = []) {
  const list = shards.length ? shards : [{ id: 'all', files: [] }];
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    for (const s of list) out.push({ dim, agent, shardId: s.id, files: s.files ?? [] });
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
    context: pieces.context ?? {},
    verify: pieces.verifySummary ?? {},
    plan,
    agentRuns: pieces.agentRuns,
    commentMode: pieces.commentMode === true,
    startedAt: pieces.startedAt ?? null,
    prNumber: pieces.prNumber ?? null,
    worktrees: pieces.worktrees ?? [],
    learningStore: plan.learning?.store ?? null,
    range: plan.range ?? null,
  };
}
