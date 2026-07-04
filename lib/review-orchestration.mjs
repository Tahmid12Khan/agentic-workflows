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

// Pure: the COMPACT intent brief handed to dimension reviewers + the gap re-dispatch — the
// criteria they trace against, the mismatches to confirm, and ONLY the scrutiny-flagged groups.
// The bulky prose fields (statedIntent/derivedIntent/expectedTests/outOfScope/extraIntents and the
// domain model/assumptions/openQuestions) stay on the deep consumers (completeness-critic + synth).
// Falls back to the raw value when intent-analyzer returned a non-object (schema miss) so a reviewer
// is never starved of intent. Derived from the union intent-analyzer output (agents/intent-analyzer.md).
export function intentBrief(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    scrutinize: (intent.groups ?? []).filter((g) => g?.scrutinize),
  };
}

// --- S6: close the false-negative gap cheaply ---

// Pure (S6.1): the COMPLETENESS-SCREEN packet — a cheap high-tier false-negative screen. Unlike the
// exhaustive critic it sees NO diff, only coverage metadata: which dimensions ran + the finding
// titles + the raw intent-analyzer (harvester) output. It can therefore flag dimension/criterion
// COVERAGE gaps but CANNOT claim untraced-taint (there is no diff to trace). `mode: screen` tells the
// reused completeness-critic agent which contract it is running. Deterministic; no I/O.
export function screenPacket({ plan = {}, findings = [], intent = {}, extraDims = [] } = {}) {
  return {
    mode: 'screen',
    dimensionsRan: [...(plan.dimensions ?? []), ...extraDims],
    findingTitles: (findings ?? []).map((f) => ({ title: f?.title, dimension: f?.dimension })).filter((t) => t.title),
    harvester: intent ?? {},   // raw intent-analyzer output (acceptance criteria live here), NOT a coverage matrix
  };
}

// Pure: keep only re-dispatchable completeness gaps (those naming a bundled agent) and cap the
// count — 6 for the exhaustive critic, a tight 1-2 for the high-tier screen (S6.1). Shared by both.
export function selectGaps(gaps = [], max = 6) {
  return (gaps ?? []).filter((g) => g?.dispatch?.agent).slice(0, Math.max(0, max));
}

// The cross-file CONSEQUENCE directive (S6.2), appended ONLY to the correctness-reviewer packet —
// its primary consumer of the context pack's caller list. Such findings are usually out-of-diff and
// the diff-scope filter demotes them to advisory by design, so the reviewer is told to raise a
// needs-human QUESTION (uncertain) when it can't tell from the pack, not a confident finding.
export const CONSEQUENCE_DIRECTIVE =
  'CROSS-FILE CONSEQUENCE: for each changed exported symbol, use the CONTEXT PACK caller list to '
  + 'state in ONE line whether each listed caller\'s assumption still holds (signature, nullability, '
  + 'ordering, error behavior). If you cannot tell from the pack, emit a needs-human question '
  + '(uncertain:true, confidence < 80), not an asserted finding.';

// Pure (S6.3): render the bug-history prior (lib/history.mjs) as a compact packet block, or '' when
// there is no fix/revert history — so it is attached only when it carries signal. Zero model cost.
export function historyBlock(history) {
  if (!history || typeof history !== 'object') return '';
  const rows = Object.entries(history)
    .filter(([, s]) => Array.isArray(s) && s.length)
    .map(([f, s]) => `${f}: ${s.join(' | ')}`);
  if (!rows.length) return '';
  return `PRIOR BUG HISTORY (recent fix/revert/hotfix commits touching the changed files — a file with a history of fixes deserves extra scrutiny):\n${rows.join('\n')}\n`;
}

// Pure (S6.4): render the executed-test signal (lib/test-signal.mjs) for the test-adequacy-reviewer
// packet — pass/fail + failing test NAMES only (never logs), or '' when tests were not run.
export function testSignalBlock(signal) {
  if (!signal || !signal.ran) return '';
  if (signal.passed) return 'EXECUTED TEST SIGNAL: the project test suite PASSED on the reviewed code.\n';
  const names = (signal.failing ?? []).filter(Boolean);
  const list = names.length ? ` Failing: ${names.join(', ')}.` : '';
  return `EXECUTED TEST SIGNAL: the project test suite FAILED on the reviewed code.${list} Weigh this against the diff — an uncovered/broken path is a real finding.\n`;
}

// Pure: the per-reviewer S6 ADDENDUM — the sandbox decision (which reviewer gets which extra signal)
// factored out and unit-tested rather than living only in the Workflow. correctness-reviewer gets
// the consequence directive (S6.2) + the bug-history prior (S6.3); test-adequacy-reviewer gets the
// executed-test signal (S6.4); every other reviewer gets ''. Empty inputs contribute nothing.
export function reviewerAddendum(agent, { history, testSignal } = {}) {
  const parts = [];
  if (agent === 'correctness-reviewer') {
    parts.push(CONSEQUENCE_DIRECTIVE);
    const hb = historyBlock(history);
    if (hb) parts.push(hb);
  } else if (agent === 'test-adequacy-reviewer') {
    const tb = testSignalBlock(testSignal);
    if (tb) parts.push(tb);
  }
  return parts.length ? '\n' + parts.join('\n') : '';
}

// --- S7: honest exhaustive independence ---

// Which reviewers run TWICE in exhaustive mode (S7.1) — a real decorrelation lever. Only the two
// highest cost-of-miss reviewers double-run; the verifier's cheap→strong model_escalate is the only
// OTHER lever that survived the honest scoping (v1's "findings-so-far withheld" is already the default
// and "shards in reverse order" is inert on an unsharded/small diff, so both were dropped).
export const DOUBLE_RUN_AGENTS = new Set(['correctness-reviewer', 'vuln-reviewer']);
export function isDoubleRunAgent(agent) { return DOUBLE_RUN_AGENTS.has(agent); }

// Union review passes and dedupe by findingKey — first occurrence wins (deterministic: findingKey has
// no Date/random, contract 4). Merges the exhaustive double-run BEFORE Verify so a finding both passes
// agree on is verified once, not twice.
export function dedupeFindings(findings = []) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const k = findingKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
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
    testSignal: pieces.testSignal ?? null,   // S6.4 executed-test signal → report header
    learningStore: plan.learning?.store ?? null,
    range: plan.range ?? null,
  };
}
