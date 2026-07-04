// Pure: helpers for the review Workflow (lib/review-workflow.mjs). Kept here so they
// are importable + unit-testable; the Workflow DSL file inlines copies because the
// Workflow sandbox has no module/filesystem access. Keep the two in sync.
import { normPath } from './trim-diff.mjs';

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

// Pure: is a finding anchored inside the change? Policy (S1.1 of plan.md) — demotion keys on
// the FILE, never on a missing line, so gate-worthy line-less findings (D1 intent /
// missing-requirement) and deletion findings are never silently un-gated:
//   - file not in the changed set              → false (out-of-diff → demote)
//   - file changed, no new-side hunks (del/mode/rename) → true  (can't localize; keep)
//   - file changed, no/invalid line            → true  (never demote on a missing line)
//   - file changed, line within a hunk ± slack → true, else false
// A finding with no `file` at all is kept (can't localize → gate-safe, don't demote on missing data).
export function inDiffScope(finding, diffIndex = {}, slack = 3) {
  const file = normPath(finding?.file);
  if (!file) return true;
  const ranges = diffIndex[file];
  if (!ranges) return false;                    // file not changed → out of diff
  if (ranges.length === 0) return true;         // changed but no new-side lines → keep
  const line = Number(finding?.line);
  if (!Number.isInteger(line) || line <= 0) return true;   // changed file, no usable line → keep
  return ranges.some(([s, e]) => line >= s - slack && line <= e + slack);
}

// Pure: split findings into in-diff (gate-affecting) and out-of-diff (advisory-only, demoted
// to the "Out-of-scope observations" report section and excluded from verdict/gate/comments).
export function partitionByScope(findings = [], diffIndex = {}, slack = 3) {
  const inScope = [], outOfDiff = [];
  for (const f of findings) (inDiffScope(f, diffIndex, slack) ? inScope : outOfDiff).push(f);
  return { inScope, outOfDiff };
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
    outOfDiff: pieces.outOfDiff ?? [],
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
