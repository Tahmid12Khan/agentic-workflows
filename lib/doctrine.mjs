// Pure: which review-doctrine fragments each reviewer agent reads, as a function of (agent, tier).
//
// Doctrine (WS1 of plan.md) is advisory review guidance — Google eng-practices lineage, ported and
// rewritten from addyosmani/agent-skills — attached BY REFERENCE, the same pattern as the context
// pack: the Workflow tells the reviewer to Read these files first, and build-args.mjs resolves the
// basenames here to absolute paths under <pluginRoot>/agents/doctrine/. Keys are AGENT names (an
// aspect covers one agent's whole dim set), not dimensions.
//
// Cost policy: doctrine attaches only on tiers >= standard (trivial/low skip it — the extra ~0.8-1.2k
// tokens/reviewer is not worth it on a small, low-risk change), and <= 2 fragments per reviewer
// (~1.5k tokens). Do NOT attach every fragment to every agent.

export const DOCTRINE_DIR = 'agents/doctrine';

// The fragment files that live under DOCTRINE_DIR. Exported so build-args + tests can assert the
// mapping only ever names a real, shipped file.
export const DOCTRINE_FILES = [
  'severity-norms.md',
  'structural-remedies.md',
  'complexity-judgment.md',
  'change-sizing.md',
];

// agent -> the doctrine fragments it reads (<= 2 each — token budget). severity-norms + change-sizing
// are the cross-cutting "how to review well" posture docs, attached to the always-on correctness
// reviewer; the two structural/complexity docs go to the simplification reviewer; complexity-judgment
// also anchors the type-design reviewer. change-sizing.md is ALSO the doctrine behind the deterministic
// change-size process advisory (signals.changeSizingAdvisory) — attaching it here keeps the fragment
// live for the reviewer that reasons about splitting a change.
const DOCTRINE_BY_AGENT = {
  'correctness-reviewer': ['severity-norms.md', 'change-sizing.md'],
  'simplification-reviewer': ['structural-remedies.md', 'complexity-judgment.md'],
  'type-design-reviewer': ['complexity-judgment.md'],
};

const TIER_ORDER = ['trivial', 'low', 'standard', 'high', 'critical'];
const MIN_DOCTRINE_TIER = 'standard';

// Doctrine fragments for one agent at a tier. [] below the standard tier (cost policy) or for an
// agent with no mapped doctrine — so a reviewer with no doctrine is never handed an empty read.
export function doctrineFiles(agent, tier) {
  if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(MIN_DOCTRINE_TIER)) return [];
  return DOCTRINE_BY_AGENT[agent] ?? [];
}

// The full agent -> [basenames] map for a tier (only agents that get doctrine at that tier). Not
// gated on which agents the plan happens to run, so a reviewer that triage adds at runtime still
// resolves its doctrine — the Workflow only reads doctrinePaths[agent] when that agent actually runs.
export function doctrineMap(tier) {
  const out = {};
  for (const agent of Object.keys(DOCTRINE_BY_AGENT)) {
    const files = doctrineFiles(agent, tier);
    if (files.length) out[agent] = files;
  }
  return out;
}
