// Pure: helpers for the review Workflow (lib/review-workflow.mjs). Kept here so they
// are importable + unit-testable; the Workflow DSL file inlines copies because the
// Workflow sandbox has no module/filesystem access. Keep the two in sync.
import { normPath } from './trim-diff.mjs';

// One review aspect per (AGENT × shard) — NOT per (dimension × shard). An agent that covers
// several dimensions (correctness-reviewer → D1/D2/D12, data-store-reviewer → D6/D8) already
// reviews all of them in a single pass per its own instructions, so spawning it once per covered
// dim ran the SAME agent over the SAME files with a near-identical prompt N times — the single
// biggest waste (a high-tier review spent 3 correctness passes on one small diff). Grouping folds
// those into one aspect carrying `dims: ['D1','D2','D12']`. Dimensions in `unsharded` get a SINGLE
// aspect over all changed files (cross-file dims like D3 security that consume the full diff
// regardless of shard). Deterministic: aspects keep first-seen order, dims keep dimensionAgents order.
//
// FILE LIST BY REFERENCE: a shard may carry `manifest` (an absolute path to a "<path>\t<slice>"
// listing build-args.mjs wrote) + `count` INSTEAD of an inline `files` array — one path per reviewed
// file was the single largest term in the args blob the orchestrator must emit verbatim, and the
// reviewer has Read anyway. Both shapes are supported and propagate to the aspect unchanged, so a
// caller that still passes inline `files` (route.mjs scrutiny targets, critic gap re-dispatch — both
// naturally small) behaves exactly as before, and a manifest write that failed degrades to inline.
// Which files, from `files`, an agent should see for one aspect — the union of per-file matches
// across every dim in `dims` that IS independently routable (ROUTED below), or the FULL `files`
// list unchanged if ANY dim the agent covers here has no routing test (never partially narrow —
// an agent mixing a routed and unrouted dim keeps full scope on both, since narrowing only one
// of its dims would silently under-serve the other). Empty match (nothing in this shard matches)
// also falls back to the full list — never dispatch a reviewer with zero files. Regex table is
// LOCAL (not module-level) so this whole function extracts as one self-contained unit for the
// SYNCED_FUNCTIONS sync test. CONTRACT_FILE deliberately mirrors lib/plan.mjs's own private
// CONTRACT_FILE constant as a separate literal — not imported across the plan/orchestration phase
// boundary, since that isn't this codebase's existing pattern.
export function routedFiles(dims, files) {
  const TEST_FILE = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]sx?$|_test\.[a-z]+$|Test\.(java|kt)$/i;
  const DATA_FILE = /\.sql$|migrat|flyway|liquibase|alembic|knex|prisma[\\/]migrations|(^|\/)(repository|dao)(\/|\.)|Repository\.(java|ts|py)$/i;
  const CONTRACT_FILE = /\.proto$|openapi|swagger|graphql|(^|\/)controller/i;
  const ROUTED = { D5: TEST_FILE, D6: DATA_FILE, D8: DATA_FILE, D10: CONTRACT_FILE };
  const tests = (dims ?? []).map((d) => ROUTED[d]);
  if (tests.some((t) => !t)) return files ?? [];
  const matched = (files ?? []).filter((f) => tests.some((t) => t.test(f)));
  return matched.length ? matched : (files ?? []);
}

export function expandAspects(dimensionAgents = {}, shards = [], { unsharded = [], allManifest = null, allParts = null } = {}) {
  const list = shards.length ? shards : [{ label: 'all', files: [] }];
  const whole = list.flatMap((s) => s.files ?? []);
  const wholeCount = list.reduce((n, s) => n + (s.count ?? (s.files ?? []).length), 0);
  const single = new Set(unsharded);
  const byKey = new Map();
  const order = [];
  // Aspects built from an `unsharded` dim (D3 today) — tracked by OBJECT REFERENCE, not by
  // `shardId === 'all'`: lib/shard.mjs's singleShard() also labels the sole shard 'all' for any
  // PR below the sharding threshold, so a label-based check would misidentify every dimension's
  // aspect as full-scope (and permanently skip narrowing) on such PRs. This set is the only
  // reliable way to know an aspect came from the single-aspect-over-everything branch below.
  const fullScope = new Set();
  // Aspect -> the owning shard's `routed` map ({agent: {manifest, parts, count}}), when present.
  // build-args.mjs precomputes this PER SHARD (it still holds the real file list in memory there,
  // unlike this sandboxed function) for any agent whose whole dim set is independently routable.
  // Keyed by aspect object, not by shard, since multiple dims can fold into the same aspect.
  const routedByAspect = new Map();
  const add = (dim, agent, shardId, files, manifest, count, parts, isFullScope, routed) => {
    const key = `${agent} ${shardId}`;
    let a = byKey.get(key);
    if (!a) { a = { dims: [], agent, shardId, files, manifest, count, parts }; byKey.set(key, a); order.push(a); }
    if (!a.dims.includes(dim)) a.dims.push(dim);
    if (isFullScope) fullScope.add(a);
    if (routed) routedByAspect.set(a, routed);
  };
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    if (single.has(dim)) { add(dim, agent, 'all', whole, allManifest, wholeCount, allParts, true); continue; }
    for (const s of list) add(dim, agent, s.label, s.files ?? [], s.manifest ?? null, s.count ?? (s.files ?? []).length, s.parts ?? null, false, s.routed ?? null);
  }
  // Dimension-routing pass (#9): resolve each non-full-scope aspect's real scope, now that every
  // dim sharing this (agent, shardId) key is known (a second dim folded into an existing aspect by
  // `add` above must get to influence the result too, which a single resolve-at-add-time pass
  // could not do).
  //   PRIMARY: a precomputed `routed[agent]` entry from build-args.mjs — this is the path that
  //   actually fires in production, where a shard's `files` are empty (by-reference: the sandbox
  //   never sees the real file list, only a manifest path + count).
  //   SECONDARY/fallback: narrow the aspect's own inline `files` via routedFiles — only live when
  //   `routed` is absent (a manifest-write failure) or a caller still supplies inline files (e.g.
  //   route.mjs's small scrutiny targets, or tests). `manifest`/`parts` are nulled only when this
  //   narrowing actually changed the list — they still point at the FULL shard's manifest/bundle on
  //   disk, which no longer matches a narrowed list; scopeFor's existing inline-`files` fallback
  //   then handles the narrowed, unbundled list correctly.
  for (const a of order) {
    if (fullScope.has(a)) continue;
    const routed = routedByAspect.get(a)?.[a.agent];
    if (routed) { a.manifest = routed.manifest; a.parts = routed.parts; a.count = routed.count; continue; }
    const narrowed = routedFiles(a.dims, a.files);
    if (narrowed.length !== a.files.length) {
      a.files = narrowed;
      a.manifest = null;
      a.parts = null;
      a.count = narrowed.length;
    }
  }
  return order;
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
// COST LEVER: a scrutinize group's `files` are reduced to BASENAMES. The reviewer already holds every
// full path it owns (its shard manifest, one "<path>\t<slice>" line per file); the group list only has
// to let it recognize which of those files are flagged, and a basename does that. On a deep-package
// codebase the full paths were ~75% of the whole brief.
export function intentBrief(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    scrutinize: (intent.groups ?? []).filter((g) => g?.scrutinize)
      .map((g) => (Array.isArray(g?.files) ? { ...g, files: g.files.map((f) => String(f).split('/').pop()) } : g)),
  };
}

// The reviewers that ACT on the acceptance-criteria model, rather than merely being handed it.
// D1 (intent alignment — "does the diff implement each criterion", scope-creep, the `scrutinize`
// groups) is correctness-reviewer's own dimension, and test-adequacy traces "does each criterion
// have a test". Every OTHER reviewer's instructions name the criteria once, in the boilerplate line
// describing its input packet, and never check them again — so the full brief was being broadcast to
// ~12 aspects for the benefit of 2. Keep this set in step with the agent files: an agent listed here
// must actually consume criteria, and one that does must be listed.
export const CRITERIA_AGENTS = new Set(['correctness-reviewer', 'test-adequacy-reviewer']);

// Pure: the per-agent slice of the intent brief. A criteria-consuming reviewer gets the whole brief;
// every other reviewer gets the one-line summary, which is what actually orients it (what this change
// is trying to do) without the criteria/mismatch/group payload it has no instruction to use. Keyed by
// AGENT, so the block stays byte-identical across that agent's aspects and shards and still leads the
// cacheable prompt prefix. Passes a non-object brief (schema miss) straight through, as intentBrief does.
export function briefFor(agent, brief) {
  if (!brief || typeof brief !== 'object') return brief;
  return CRITERIA_AGENTS.has(agent) ? brief : { summary: brief.summary };
}

// Pure: the SYNTHESIZER's slice of the intent model. review-synthesizer.md consumes exactly three
// things from it — acceptanceCriteria (the traceability matrix it must emit), mismatches ("reflect
// intent mismatches as uncovered criteria or findings"), and summary (framing for the one-sentence
// verdict). openQuestions is deliberately NOT here: the workflow passes it as its own labelled term
// so the rule that routes it into `needsHuman` still has something obviously named to bind to —
// folding it in here would have made it the one field sent twice. Nothing in the synthesizer's
// contract reads statedIntent/derivedIntent/expectedTests/outOfScope/extraIntents/model/assumptions/
// businessRisks/groups, so none of them travel.
export function synthIntent(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
  };
}

// Pure: the EXHAUSTIVE completeness-critic's slice. Unlike the reviewers, this one earns the long
// tail — every field kept maps onto a gap kind it is allowed to emit (agents/completeness-critic.md):
// acceptanceCriteria/mismatches → uncovered-criterion, expectedTests → missing-test, businessRisks →
// unreviewed-risk-path, openQuestions → unverified-claim. The group CLUSTERING survives too (it is how
// the critic argues a dimension should have run for some area of the change), but the per-group FILE
// lists do not: the exhaustive critic is handed the full diff AND the changed-file manifest, so those
// paths are already in its prompt twice. Dropped entirely: statedIntent/derivedIntent (restated by
// summary + criteria), model, assumptions, outOfScope, extraIntents — no gap kind consumes them.
// NOTE: this is the exhaustive path only. The cheap SCREEN keeps the RAW intent — see screenPacket.
export function criticIntent(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    expectedTests: intent.expectedTests,
    businessRisks: intent.businessRisks,
    openQuestions: intent.openQuestions,
    groups: (intent.groups ?? []).map(({ files, ...rest }) => rest),
  };
}

// Pure: truncate a string to `n` chars (never throws on non-string). Shared by intentContext's fields.
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Pure: the intent-analyzer's REAL context digest — PR title+body, existing PR comments, commit
// subjects, and linked tickets — capped so the packet stays bounded. intent-analyzer.md is designed
// to read all of this (agents/intent-analyzer.md "Sources for STATED intent"), but until this helper
// existed the workflow only forwarded bundle.summary (a one-line count string from gather.mjs), so
// the analyzer never actually saw the PR body/comments/commits/tickets it was told to consult. Every
// truncation point is a fixed length (never Date/random), so the same bundle always yields the same
// digest. Caps: PR title+body ~4000 chars, each comment ~500 chars (max 10), commit subjects ~200
// chars (max 20), each ticket ~1000 chars — then the WHOLE digest is capped again (~12000 chars) as a
// hard ceiling in case every section is near its own cap at once.
export function intentContext(bundle = {}, { maxTotal = 12000 } = {}) {
  const parts = [];
  if (bundle?.pr) {
    const title = truncate(bundle.pr.title, 300);
    const body = truncate(bundle.pr.body, 4000);
    parts.push(`PR: ${title}\n${body}`.trim());
  }
  const comments = (bundle?.existingComments ?? []).slice(0, 10)
    .map((c) => `- ${c?.author ?? '?'}: ${truncate(c?.body, 500)}`);
  if (comments.length) parts.push(`Existing PR comments:\n${comments.join('\n')}`);
  const commits = (bundle?.commits ?? []).slice(0, 20).map((c) => `- ${truncate(c?.subject, 200)}`);
  if (commits.length) parts.push(`Commits:\n${commits.join('\n')}`);
  const tickets = (bundle?.tickets ?? []).map((t) => {
    const head = `${t?.tracker ?? 'issue'} ${t?.key ?? ''}: ${t?.title ?? ''}`;
    const desc = t?.description ?? t?.body ?? '';
    return truncate(desc ? `${head} — ${desc}` : head, 1000);
  });
  if (tickets.length) parts.push(`Linked tickets:\n${tickets.join('\n')}`);
  return truncate(parts.join('\n\n'), maxTotal);
}

// --- S6: close the false-negative gap cheaply ---

// Pure (S6.1): the COMPLETENESS-SCREEN packet — a cheap high-tier false-negative screen. Unlike the
// exhaustive critic it sees NO diff, only coverage metadata: which dimensions ran + the finding
// titles + the raw intent-analyzer (harvester) output. It can therefore flag dimension/criterion
// COVERAGE gaps but CANNOT claim untraced-taint (there is no diff to trace). `mode: screen` tells the
// reused completeness-critic agent which contract it is running. Deterministic; no I/O.
// DO NOT swap `harvester` for criticIntent() or any other projection. The screen is the one intent
// consumer with NO diff, and since v0.26.0 args carries no changed-file list either — so
// `harvester.groups[].files` is the ONLY source of paths left in its prompt, and its gap contract
// REQUIRES a `dispatch.files` to re-dispatch against. Trimming those paths here does not shrink a
// reviewer prompt (the screen runs once) and would leave it unable to name a target.
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
// When `validAgents` is supplied, a gap whose dispatch.agent is NOT one of those real bundled agents
// is dropped: the completeness-critic LLM can hallucinate a plausible-but-nonexistent name (e.g.
// "intent-verifier" ~ the real "intent-analyzer"), and re-dispatching it throws "agent type not
// found". Filtering here removes the wasted dispatch + the error entirely. null = no name check.
export function selectGaps(gaps = [], max = 6, validAgents = null) {
  const ok = validAgents == null ? null : new Set(validAgents);
  return (gaps ?? []).filter((g) => g?.dispatch?.agent && (ok == null || ok.has(g.dispatch.agent))).slice(0, Math.max(0, max));
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

// Pure (S6.3): the bug-history prior (lib/history.mjs) rides on the packet BY REFERENCE — build-args.mjs
// resolves it to an absolute path only when it carries signal (non-empty, on disk), so this returns a
// Read instruction rather than formatting the data inline (inlining it cost 6+ KB on a 69-file PR, the
// second-largest term in the args payload the orchestrator must emit verbatim). '' for a null/absent
// path, so the block is a true no-op — no tokens, no perturbation of the prompt-cache prefix.
export function historyBlock(historyPath) {
  if (!historyPath) return '';
  return `PRIOR BUG HISTORY: Read ${historyPath} — recent fix/revert/hotfix commits touching the changed files, shaped { history: { <file>: [<commit subject>, ...] }, notes: [...] }. A file with a history of fixes deserves extra scrutiny.\n`;
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
export function reviewerAddendum(agent, { historyPath, testSignal } = {}) {
  const parts = [];
  if (agent === 'correctness-reviewer') {
    parts.push(CONSEQUENCE_DIRECTIVE);
    const hb = historyBlock(historyPath);
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
