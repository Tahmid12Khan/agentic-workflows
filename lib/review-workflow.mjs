export const meta = {
  name: 'acr-review',
  description: 'Adversarial code review fan-out: intent, dimension review, batched sonnet-first Verify (≤N groups + 1 opus reverify guard), synthesize, render.',
  phases: [
    { title: 'Intent' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
};

// --- inlined pure helpers (canonical + tested: lib/review-orchestration.mjs) ---
const findingKey = (f = {}) => `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
// One aspect per (AGENT × shard): dims sharing an agent (correctness → D1/D2/D12, data-store →
// D6/D8) fold into ONE aspect carrying `dims: [...]` instead of spawning a duplicate agent per dim.
function expandAspects(dimensionAgents = {}, shards = [], { unsharded = [] } = {}) {
  const list = shards.length ? shards : [{ label: 'all', files: [] }];
  const whole = list.flatMap((s) => s.files ?? []);
  const single = new Set(unsharded);
  const byKey = new Map();
  const order = [];
  const add = (dim, agent, shardId, files) => {
    const key = `${agent} ${shardId}`;
    let a = byKey.get(key);
    if (!a) { a = { dims: [], agent, shardId, files }; byKey.set(key, a); order.push(a); }
    if (!a.dims.includes(dim)) a.dims.push(dim);
  };
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    if (single.has(dim)) { add(dim, agent, 'all', whole); continue; }
    for (const s of list) add(dim, agent, s.label, s.files ?? []);
  }
  return order;
}
// Compact intent brief for the dimension reviewers + gap re-dispatch: criteria + mismatches + only
// the scrutiny-flagged groups. Bulky prose (statedIntent/derivedIntent/expectedTests/outOfScope/
// extraIntents/domain model) is reserved for the deep consumers (completeness-critic + synth).
// Falls back to the raw value on a schema miss so a reviewer is never starved of intent.
function intentBrief(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    scrutinize: (intent.groups ?? []).filter((g) => g?.scrutinize),
  };
}

// --- inlined S7 helpers (canonical + tested: lib/review-orchestration.mjs) ---
// S7.1: correctness + vuln reviewers run twice in exhaustive mode (real decorrelation); their two
// passes are unioned + deduped by findingKey (first wins; deterministic) before Verify.
const DOUBLE_RUN_AGENTS = new Set(['correctness-reviewer', 'vuln-reviewer']);
const isDoubleRunAgent = (agent) => DOUBLE_RUN_AGENTS.has(agent);
function dedupeFindings(findings = []) {
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

// --- inlined S6 helpers (canonical + tested: lib/review-orchestration.mjs) ---
// S6.1 completeness screen packet: coverage metadata only (dims ran + finding titles + raw intent),
// NO diff — so it flags dimension/criterion coverage gaps, never untraced-taint.
function screenPacket({ plan = {}, findings = [], intent = {}, extraDims = [] } = {}) {
  return {
    mode: 'screen',
    dimensionsRan: [...(plan.dimensions ?? []), ...extraDims],
    findingTitles: (findings ?? []).map((f) => ({ title: f?.title, dimension: f?.dimension })).filter((t) => t.title),
    harvester: intent ?? {},
  };
}
// keep only re-dispatchable gaps (naming a bundled agent) and cap the count (6 exhaustive / 1-2 screen).
function selectGaps(gaps = [], max = 6) { return (gaps ?? []).filter((g) => g?.dispatch?.agent).slice(0, Math.max(0, max)); }
// S6.2 cross-file consequence directive — appended to the correctness-reviewer packet only.
const CONSEQUENCE_DIRECTIVE =
  'CROSS-FILE CONSEQUENCE: for each changed exported symbol, use the CONTEXT PACK caller list to '
  + 'state in ONE line whether each listed caller\'s assumption still holds (signature, nullability, '
  + 'ordering, error behavior). If you cannot tell from the pack, emit a needs-human question '
  + '(uncertain:true, confidence < 80), not an asserted finding.';
// S6.3 bug-history prior (history.mjs) → compact packet block, '' when no fix/revert history.
function historyBlock(history) {
  if (!history || typeof history !== 'object') return '';
  const rows = Object.entries(history).filter(([, s]) => Array.isArray(s) && s.length).map(([f, s]) => `${f}: ${s.join(' | ')}`);
  if (!rows.length) return '';
  return `PRIOR BUG HISTORY (recent fix/revert/hotfix commits touching the changed files — a file with a history of fixes deserves extra scrutiny):\n${rows.join('\n')}\n`;
}
// S6.4 executed-test signal (test-signal.mjs) → test-adequacy-reviewer packet, '' when not run.
function testSignalBlock(signal) {
  if (!signal || !signal.ran) return '';
  if (signal.passed) return 'EXECUTED TEST SIGNAL: the project test suite PASSED on the reviewed code.\n';
  const names = (signal.failing ?? []).filter(Boolean);
  const list = names.length ? ` Failing: ${names.join(', ')}.` : '';
  return `EXECUTED TEST SIGNAL: the project test suite FAILED on the reviewed code.${list} Weigh this against the diff — an uncovered/broken path is a real finding.\n`;
}
// the per-reviewer S6 addendum (which reviewer gets which extra signal). Empty inputs contribute ''.
function reviewerAddendum(agent, { history, testSignal } = {}) {
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

// --- inlined diff-scope demotion (canonical + tested: lib/review-orchestration.mjs
// inDiffScope/partitionByScope; the diffIndex it consumes is precomputed by build-args.mjs
// via lib/trim-diff.mjs buildDiffIndex and arrives in `args.diffIndex`) ---
// ARGS-BY-REFERENCE: the diff is NEVER inlined into this sandbox — reviewers/verifiers Read it
// from `args.diffPath` and focus on their file list, so the sandbox no longer trims diff text
// (the old filterDiff/stripNoise are gone). The one diff-derived datum the sandbox still needs
// is the compact line-range index for off-diff demotion; it is passed in, not recomputed here.
// Findings anchored outside the actual change are advisory-only: shown in the report but
// excluded from the verdict/gate/comments. Demotion keys on the FILE, never a missing line,
// so gate-worthy line-less (D1/intent) and deletion findings are never silently un-gated.
const normPath = (p) => (typeof p !== 'string' ? '' : p.split('\t')[0].replace(/^[ab]\//, '').trim());
function inDiffScope(finding, diffIndex = {}, slack = 3) {
  const file = normPath(finding?.file);
  if (!file) return true;
  const ranges = diffIndex[file];
  if (!ranges) return false;
  if (ranges.length === 0) return true;
  const line = Number(finding?.line);
  if (!Number.isInteger(line) || line <= 0) return true;
  return ranges.some(([s, e]) => line >= s - slack && line <= e + slack);
}
function partitionByScope(findings = [], diffIndex = {}, slack = 3) {
  const inScope = [], outOfDiff = [];
  for (const f of findings) (inDiffScope(f, diffIndex, slack) ? inScope : outOfDiff).push(f);
  return { inScope, outOfDiff };
}

// Plugin agents register namespaced (adversarial-code-review:<name>); a bare name
// only resolves on the plugin's own repo. Resolve every bundled agentType through this.
const pluginAgent = (t) => (!t || t === 'general-purpose' || t.includes(':') ? t : `adversarial-code-review:${t}`);

// --- inlined verification policy (canonical + tested: lib/verify.mjs) ---
// Selecting which findings to verify + resolving verdicts is pure: run it inline
// rather than spawning a general-purpose executor agent to `node verify.mjs resolve`.
// Config is resolved ONCE in plan.mjs (which can import verify.mjs); the sandbox consumes the
// resolved camelCase plan.verify directly (see `policy` below) and must NOT re-resolve raw config —
// so verifyPolicy/cleanVerify are intentionally NOT inlined here, only the pure decision helpers are.
const DEFAULT_VERIFY = { maxPassesPerAspect: 3, maxSubagentsPerAspect: 3, reverifyBelow: 80, reportConfidence: 80, escalateUncertain: true, maxVerifierAgents: 5, verifyModel: 'opus', modelFirst: 'sonnet', modelEscalate: 'opus', escalateDirectSeverity: ['critical'] };
const HOT_SEVERITIES = ['critical', 'important', 'high'];
// Batch selected findings into ≤ maxAgents verifier groups by (verifier lens, file) — canonical +
// tested in lib/verify.mjs groupForVerification. Every finding lands in exactly one group (the cap
// bounds AGENT COUNT, never coverage); lens separation (taint vs generic) is preserved; each group's
// diff is paid once per agent. Deterministic (no Date/random; stable index tie-breaks).
function groupForVerification(findings = [], maxAgents = DEFAULT_VERIFY.maxVerifierAgents) {
  const items = (findings ?? []).filter((f) => f && f.verifier);
  if (!items.length) return [];
  const cap = Math.max(1, Math.floor(maxAgents) || 0);
  const byVerifier = new Map();
  for (const f of items) { if (!byVerifier.has(f.verifier)) byVerifier.set(f.verifier, []); byVerifier.get(f.verifier).push(f); }
  const verifiers = [...byVerifier.keys()];
  const seats = distributeSeats(verifiers.map((v) => byVerifier.get(v).length), Math.max(cap, verifiers.length));
  const groups = [];
  verifiers.forEach((v, i) => { for (const bucket of binByFile(byVerifier.get(v), seats[i])) groups.push({ verifier: v, files: [...new Set(bucket.map((f) => f.file).filter(Boolean))], findings: bucket }); });
  return groups;
}
function distributeSeats(loads, total) {
  const seats = loads.map(() => 1);
  let remaining = total - seats.length;
  while (remaining > 0) { let best = 0; for (let i = 1; i < loads.length; i++) if (loads[i] / seats[i] > loads[best] / seats[best]) best = i; seats[best]++; remaining--; }
  return seats;
}
function binByFile(findings, nBuckets) {
  const byFile = new Map();
  for (const f of findings) { const k = f.file ?? ''; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(f); }
  const fileGroups = [...byFile.values()];
  const n = Math.max(1, Math.min(Math.floor(nBuckets) || 1, fileGroups.length));
  if (fileGroups.length <= n) return fileGroups;
  const sorted = fileGroups.slice().sort((a, b) => b.length - a.length);
  const buckets = Array.from({ length: n }, () => []);
  for (const g of sorted) { let s = 0; for (let i = 1; i < buckets.length; i++) if (buckets[i].length < buckets[s].length) s = i; buckets[s].push(...g); }
  return buckets;
}
function isOnRiskPath(f, riskPaths) {
  if (!riskPaths || riskPaths.size === 0) return false;
  const file = (f.file ?? '').toLowerCase();
  for (const r of riskPaths) if (file.includes(r)) return true;
  return false;
}
// Re-check ONLY the unsure: low-confidence, explicitly uncertain, or high-severity on a
// risk path. A confident, non-risk finding is trusted and ships without a verifier pass.
function selectForVerification(findings, policy = DEFAULT_VERIFY, opts = {}) {
  const riskPaths = new Set(opts.riskPaths ?? []);
  return (findings ?? []).filter((f) => {
    if (f.uncertain === true) return true;
    if (f.confidence == null) return true;            // unscored → always verify (never a free pass)
    if (f.confidence < policy.reverifyBelow) return true;
    const hot = ['critical', 'important', 'high'].includes(f.severity);
    return hot && isOnRiskPath(f, riskPaths);
  });
}
function resolveVerification(finding, verdicts = [], policy = DEFAULT_VERIFY) {
  const used = verdicts.slice(0, policy.maxVerifierPasses);
  const real = used.filter((v) => v.verdict === 'real').length;
  const refuted = used.filter((v) => v.verdict === 'refuted').length;
  const passes = 1 + used.length;
  const scored = finding.confidence != null;
  let decision, confidence = scored ? finding.confidence : 0;
  const wasLowConf = !scored || confidence < policy.reportConfidence;
  const hot = ['critical', 'important', 'high'].includes(finding.severity);
  const twoLooksAffordable = policy.maxVerifierPasses >= 2;
  if (used.length === 0) decision = 'keep';
  else if (refuted > real) decision = (hot && refuted < 2 && twoLooksAffordable && policy.escalateUncertain) ? 'needs-human' : 'drop';
  else if (real > refuted) {
    if (wasLowConf && real < 2) decision = policy.escalateUncertain ? 'needs-human' : 'drop';
    else { decision = 'keep'; confidence = Math.max(confidence, 80); }
  } else decision = policy.escalateUncertain ? 'needs-human' : 'drop';
  return { ...finding, confidence, verify: { passes, real, refuted, decision, capped: verdicts.length > used.length, lenses: [...new Set(used.map((v) => v.lens).filter(Boolean))] }, decision };
}
function partition(resolvedList, policy = DEFAULT_VERIFY) {
  const report = [], dropped = [], needsHuman = [];
  for (const f of resolvedList) {
    if (f.decision === 'needs-human') needsHuman.push(f);
    else if (f.decision === 'drop') dropped.push(f);
    else if ((f.confidence ?? 0) >= policy.reportConfidence) report.push(f);
    else needsHuman.push({ ...f, decision: 'needs-human' });
  }
  return { report, dropped, needsHuman };
}

// --- schemas (force structured sub-agent output) ---
const FINDING = {
  type: 'object',
  properties: {
    dimension: { type: 'string' }, severity: { enum: ['critical', 'important', 'minor', 'suggestion'] },
    file: { type: 'string' }, line: { type: 'number' },
    // Last original line of a multi-line fix range (line..endLine, inclusive); unset/absent means
    // the finding + any fixCode apply to the single `line`. Only ever copied through, never inferred.
    endLine: { type: 'number' },
    title: { type: 'string' },
    evidence: { type: 'string' }, fix: { type: 'string' },
    // Exact replacement, set only when a reviewer is letter-for-letter confident — comments.mjs
    // renders it as a ```suggestion block GitHub can apply in one click (single-line at `line`, or
    // spanning line..endLine). Empty/absent falls back to the prose `fix`.
    fixCode: { type: 'string' },
    confidence: { type: 'number' },
    uncertain: { type: 'boolean' },
    // Carried through synthesis so the report can show verified-vs-trusted per finding. The
    // reviewers leave this empty (verify runs after review); the synthesizer COPIES the verify
    // block the verifier produced — without this field it was silently stripped and no tag showed.
    verify: {
      type: 'object',
      properties: {
        passes: { type: 'number' }, real: { type: 'number' }, refuted: { type: 'number' },
        decision: { type: 'string' }, lenses: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['severity', 'file', 'title'],
};
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: { strengths: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: FINDING } },
  required: ['findings'],
};
// Batched verifier output: one verdict per finding, keyed by the finding's `id` (its findingKey,
// copied verbatim from the packet) so the orchestrator can map verdicts back to findings.
const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, verdict: { enum: ['real', 'refuted', 'uncertain'] },
          lens: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' },
        },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['verdicts'],
};
const GAPS_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' }, what: { type: 'string' }, where: { type: 'string' },
          dispatch: {
            type: 'object',
            properties: { agent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, focus: { type: 'string' } },
            required: ['agent'],
          },
        },
        required: ['kind', 'dispatch'],
      },
    },
    assessment: { type: 'string' },
  },
  required: ['gaps'],
};
// Force the merged intent model to a structured object (was free-form text → escaped-string blob
// broadcast verbatim into every downstream prompt). Structured lets us hand reviewers a COMPACT
// brief (criteria + mismatches + flagged groups) instead of the full prose model — the bulky
// statedIntent/derivedIntent/expectedTests/outOfScope + the domain-logic fields stay only on the
// deep consumers (completeness-critic, synth). This is the FULL UNION of the former intent-harvester
// + business-logic-analyzer contracts (S3 of plan.md); acceptanceCriteria is REQUIRED because four
// consumers read it (reviewer brief, completeness-critic, gap re-dispatch, synth traceability).
// Mirrors agents/intent-analyzer.md's documented shape.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, statedIntent: { type: 'string' }, derivedIntent: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' } } } },
    expectedTests: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    mismatches: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' } } } },
    groups: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, intent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, kind: { type: 'string' }, withinScope: { type: 'boolean' }, note: { type: 'string' }, scrutinize: { type: 'boolean' } } } },
    extraIntents: { type: 'array', items: { type: 'string' } },
    // business-logic union (former business-logic-analyzer): domain model + assumptions + open questions.
    model: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, grounded: { type: 'boolean' }, source: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, file: { type: 'string' }, why: { type: 'string' } } } },
    businessRisks: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, severity: { type: 'string' } } } },
  },
  required: ['acceptanceCriteria'],
};
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, summaryPoints: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    criteria: { type: 'array' }, findings: { type: 'array', items: FINDING },
    needsHuman: { type: 'array' }, skipped: { type: 'array' },
  },
  required: ['findings'],
};

// args arrives as a JSON STRING (confirmed via spike), not a parsed object — parse defensively.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
const { plan, bundle, diffPath, contextPackPath, diffIndex, history, testSignal, shards, routing, flags, startedAt, prNumber, checkout, sliceIndex } = A;
// Shared context pack (context-pack.mjs, built once in /review step 3): the enclosing definitions
// of changed code, import blocks, and in-repo callers of changed exports. ARGS-BY-REFERENCE: it is
// on disk at contextPackPath, so a reviewer is told to Read it FIRST (before the diff) and then
// needs at most a few extra Read/Grep calls (S2 of plan.md). The instruction is byte-identical
// across every aspect of the same reviewer agent, so it LEADS the packet and prompt-caches across
// them. null when the pre-step was skipped → reviewers fall back to their own Read/Grep. The caller
// section rides in the pack; the correctness reviewer is its primary consumer (S6.2).
const packBlock = contextPackPath
  ? `A shared CONTEXT PACK (enclosing definitions of the changed code, import blocks, and in-repo callers of the changed exports) is on disk at ${contextPackPath} — Read it FIRST, before the diff.\n\n`
  : '';
// ARGS-BY-REFERENCE: every agent Reads the full diff from diffPath itself and focuses on its file
// list — the sandbox no longer inlines diff text. Reviewers/verifiers/critic all point at diffPath;
// intent is additionally told to ignore lockfile/build-artifact/vendored churn (the old stripNoise).
const diffRead = `Read the diff at ${diffPath}.`;
// COST LEVER — per-aspect diff slicing: build-args.mjs wrote each changed file's hunks to its own
// slice on disk (args.sliceIndex maps normPath → slice path). A file-scoped agent (a dimension
// reviewer, a generic verifier group, a gap re-dispatch) Reads ONLY the slices for its files instead
// of the whole diff — the dominant input-token cost, otherwise paid in full once per agent. It is a
// pure optimization: when no slice exists for the requested files (rename/binary/noise, or an empty
// sliceIndex because slicing was skipped), it FALLS BACK to the full diff so a reviewer is never
// starved. Callers that must reason cross-file (D3/taint, intent, the reverify guard, the exhaustive
// critic) deliberately pass the full diffRead instead.
const sliceIdx = sliceIndex ?? {};
const slicesFor = (files = []) => [...new Set((files ?? []).map((f) => sliceIdx[normPath(f)]).filter(Boolean))];
const diffReadFor = (files) => {
  const s = slicesFor(files);
  if (!s.length) return diffRead;   // no slice for these files → full diff (never a starved reviewer)
  return `Read the per-file diff slice(s) for the file(s) you are reviewing: ${s.join(', ')} — these hold the complete changed hunks for those files (Read only these, not the whole diff).`;
};
// REVIEW.md (plan.reviewInstructions, resolved in plan.mjs): review-SPECIFIC mandatory guidance,
// injected verbatim as the highest-priority, cache-leading block into every finding-generating agent
// (reviewers + intent + critic). Distinct from projectRules (general repo conventions, passed as paths).
// It LEADS each prompt and is byte-identical across aspects, so it prompt-caches like packBlock.
// '' when unset → the block is a no-op that adds no tokens and does not perturb the cache prefix.
const reviewBlock = plan.reviewInstructions
  ? `MANDATORY REVIEW INSTRUCTIONS (highest priority — follow these over general project conventions when they conflict):\n${plan.reviewInstructions}\n\n`
  : '';
const notes = [];
const agentRuns = {};
const bump = (name) => { agentRuns[name] = (agentRuns[name] ?? 0) + 1; };

// reviewer packet: NEVER includes this chat's history
const basePacket = {
  summary: bundle?.summary ?? '',
  projectRules: plan.projectRules ?? [],
};

// ---------------------------------------------------------------- Triage sanity-check (first reasoning step)
// The deterministic plan.mjs already fixed the tier/dimensions; this is a judgment pass on
// blast radius. A RAISED tier can't safely re-plan mid-flight (dimensions/models arrive fixed
// in args, and the sandbox can't recompute them) so it is surfaced for the human. Dimensions it
// ADDS we CAN honor — they become real review aspects below, resolved via dimensionAgentsAll.
phase('Intent');
const TIER_RANK = { trivial: 0, low: 1, standard: 2, high: 3, critical: 4 };
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: { tier: { type: 'string' }, addDimensions: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
  required: ['tier'],
};
// triage (tier sanity-check) and intent do NOT depend on each other — triage's output only feeds the
// Review phase (extra dims), intent needs none of it — so launch BOTH and await together instead of
// paying their latencies back-to-back. This roughly halves the Intent-phase wall-clock. triage is
// skipped for TRIVIAL only (dims fixed to D2+D13, verify/critic off → a judgment-based dim add is the
// lowest-value call there); low+ KEEPS it. `plan.models` is intentionally omitted from the triage
// prompt: it judges blast radius/tier, never model assignment.
const triageP = plan.tier === 'trivial' ? Promise.resolve(null) : agent(
  `Sanity-check this review tier using judgment about blast radius. Decide from the signals + diff summary + file list provided below — do NOT read files or run git to make this call (only Read a single specific file if a tier decision genuinely hinges on its content). Signals: ${JSON.stringify(plan.signals)}. ` +
  `Draft plan — tier: ${plan.tier}, dimensions: ${JSON.stringify(plan.dimensions)}. ` +
  `Changed files: ${JSON.stringify(plan.files)}. Diff summary: ${plan.diffSummary}.`,
  { agentType: pluginAgent('triage-classifier'), model: 'haiku', label: 'triage', phase: 'Intent', schema: TRIAGE_SCHEMA },
).then((r) => (bump('triage-classifier'), r)).catch((e) => { notes.push(`triage-classifier failed: ${e.message}`); return null; });

// ---------------------------------------------------------------- Intent
// ONE merged pass (intent-analyzer = former intent-harvester + business-logic-analyzer, S3 of
// plan.md): a single diff payment yields the whole intent model — acceptance criteria, mismatches,
// primary/extra grouping, AND the domain/business-logic model with assumptions + open questions.
// Diff first here is convention, NOT a caching win: intent-analyzer runs ONCE and is a distinct
// agent (own system prompt, sometimes its own model) from the reviewers/verifiers, so its diff does
// NOT prompt-cache with them — cross-agent caching is impossible (the cache key includes the system
// prompt; no user-text ordering bridges two agents). The real reuse is INTRA-agent: the same reviewer
// across shards and the same verifier across same-scope findings (see those passes below); the
// report's per-scope cache-hit% panel shows the actual rate. The prompt enforces STAGED reasoning
// (criteria/groups BEFORE assumptions/questions) so merging the two agents does not collapse the producer→consumer
// reasoning barrier the split gave for free. Runs at low+ (skipped only on the trivial inline path,
// where the Workflow is never invoked) so even low-tier reviewers still get their intent brief.
// S6.3: the deterministic bug-history prior (history.mjs) rides on the intent packet + the
// correctness packets — a file with a history of fix/revert commits deserves extra scrutiny. '' when
// there is no such history, so it is attached only when it carries signal. Zero model cost.
const historyPrior = historyBlock(history);
const intentP = agent(
  `${reviewBlock}` +
  `Read the diff at ${diffPath} (ignore lockfile/build-artifact/vendored churn — focus on the source/test/config changes).\n\nIn ORDER: (1) build the acceptance-criteria model (stated vs derived intent + mismatches), (2) cluster the diff into intent groups (primary vs EXTRA), flagging the groups that need scrutiny, THEN (3) model the domain/business logic — list assumptions + OPEN QUESTIONS (do not guess on material ambiguity). Context: ${JSON.stringify(basePacket)}. Diff summary: ${plan.diffSummary}.${historyPrior ? `\n${historyPrior}` : ''}`,
  // model PINNED to sonnet: a Workflow agent with no model opt inherits the SESSION model — running
  // /review from an opus session silently upgraded intent (+ synth + gap re-dispatch) to opus, blowing
  // the budget. Pin them so cost is deterministic and matches the agent frontmatter (intent = sonnet).
  // label PINNED so the progress UI shows "intent" instead of falling back to the prompt's first line.
  { agentType: pluginAgent('intent-analyzer'), model: 'sonnet', label: 'intent', phase: 'Intent', schema: INTENT_SCHEMA },
).then((r) => (bump('intent-analyzer'), r));

// Await the two independent Intent-phase agents together (launched above).
const [triage, intent] = await Promise.all([triageP, intentP]);

const triageExtraDims = [];
if (triage) {
  if ((TIER_RANK[triage.tier] ?? -1) > (TIER_RANK[plan.tier] ?? -1)) {
    notes.push(`triage-classifier suggests tier ${triage.tier} > computed ${plan.tier}: ${triage.reason ?? ''}`);
  }
  for (const d of triage.addDimensions ?? []) {
    if (!(plan.dimensions ?? []).includes(d) && (plan.dimensionAgentsAll ?? {})[d] && !triageExtraDims.includes(d)) triageExtraDims.push(d);
  }
}

// ---------------------------------------------------------------- Review (barrier) → batched Verify
phase('Review');
// Compact intent brief for the dimension reviewers (intentBrief, inlined above): the criteria they
// trace against, the mismatches to confirm, and ONLY the groups flagged for scrutiny. The full prose
// model + domain-logic fields are reserved for the deep consumers (completeness-critic + synth).
const brief = intentBrief(intent);
// plan.verify is ALREADY RESOLVED (camelCase) by plan.mjs — merge it over the defaults. Do NOT
// re-resolve via cleanVerify (it maps only raw snake_case config, so it would silently revert every
// customized field back to its default). maxVerifierAgents is the per-tier batched-verify budget.
const policy = { ...DEFAULT_VERIFY, ...(plan.verify ?? {}) };
const riskPaths = plan.signals?.riskPaths ?? [];
// D3 (security) consumes the FULL diff regardless of shard (cross-file taint source→sink), so
// sharding it only re-pays the whole diff per shard. Collapse it to ONE aspect over all files.
const aspects = expandAspects(plan.dimensionAgents, shards, { unsharded: ['D3'] });
// extra-intent scrutiny + mandatory checks become additional aspects (computed in the main agent via route.mjs)
for (const t of routing?.scrutiny?.targets ?? []) aspects.push({ dims: [t.label], agent: 'correctness-reviewer', shardId: 'scrutiny', files: t.files });
// dimensions triage-classifier judged were missed → real aspects (reviewed + verified like any other)
for (const d of triageExtraDims) aspects.push({ dims: [d], agent: plan.dimensionAgentsAll[d], shardId: 'triage', files: plan.files ?? [] });

// ARGS-BY-REFERENCE: a dimension reviewer Reads the full diff from diffPath and is told to review
// ONLY its aspect's file list (below), so it focuses without the sandbox pre-slicing diff text.
// D3 (security) still reasons over the whole diff for cross-file taint source→sink; the file-list
// scope is advisory focus, not a hard cut, so a reviewer is never starved of a needed hunk.

// ---- Batched verification (all on plan.verify.verifyModel = opus; ≤ maxVerifierAgents groups + 1) ----
// The user's cost lever: instead of one verifier agent PER finding (unbounded, and mostly cold-cache
// since same-prefix agents run concurrently and can't read each other's cache), GROUP the selected
// (unsure) findings by (verifier lens, file) into at most maxVerifierAgents groups (per-tier: 3/5/8)
// and refute a whole group in ONE opus pass — the diff is paid once per group, and agent count stops
// scaling with finding count. Every selected finding is still verified (the cap bounds AGENT COUNT,
// never coverage). A finding NOT selected is trusted and carried through unverified.
const verifierFor = (f) => (f.dimension === 'D3' && plan.discovery?.taint) ? 'taint-verifier' : 'finding-verifier';
const verifyPayload = (f) => ({ id: findingKey(f), dimension: f.dimension, severity: f.severity, file: f.file, line: f.line, title: f.title, evidence: f.evidence, fix: f.fix });
const verifyModel = plan.verify?.verifyModel ?? policy.verifyModel;
// COST LEVER — sonnet-first batched verify: the first-pass refuter groups run on the CHEAP model
// (modelFirst = sonnet), NOT opus. The asymmetry is deliberate — a sonnet false CONFIRM only lets a
// spurious finding through (annoying, human sees it), while a sonnet false REFUTE would MISS a real
// bug; the +1 opus reverify guard below re-checks exactly the refuted/uncertain HOT findings with the
// bias inverted, so opus adjudicates every costly kill. Two exceptions go straight to opus on the
// first pass: a group holding a CRITICAL finding (escalate_direct_severity) and the taint-verifier
// (D3 cross-file security, exhaustive-only) — the cases where even a confirm is worth the strong model.
const firstModel = plan.verify?.modelFirst ?? policy.modelFirst;
const escDirectSev = new Set(policy.escalateDirectSeverity ?? DEFAULT_VERIFY.escalateDirectSeverity);

// One batched verifier group → writes { verdict, lens } per finding id into verdictByKey. taint keeps
// the FULL diff (cross-file source→sink); a generic group is file-scoped, reading only its files'
// slices (diff paid once, sliced, for the group). Diff-first ordering keeps that prefix cacheable if
// the same group scope recurs. A failed group degrades every finding in it to 'uncertain' (never crashes).
const spawnBatchVerifier = (group, verdictByKey) => {
  const payload = group.findings.map(verifyPayload);
  const isTaint = group.verifier === 'taint-verifier';
  const focus = isTaint
    ? 'Trace each finding across ALL changed files (cross-file taint source→sink).'
    : `Focus on the file(s): ${JSON.stringify(group.files)}.`;
  const gDiffRead = isTaint ? diffRead : diffReadFor(group.files);
  const groupModel = (isTaint || group.findings.some((f) => escDirectSev.has(f.severity))) ? verifyModel : firstModel;
  return agent(
    `${gDiffRead} ${focus}\n\nAdversarially REFUTE EACH of these ${payload.length} finding(s) INDEPENDENTLY by reading the real code path around each file:line. Return one verdict per finding, keyed by its "id" (copy the id verbatim; one verdict object per finding). Findings: ${JSON.stringify(payload)}.`,
    { agentType: pluginAgent(group.verifier), model: groupModel, label: `verify:${group.verifier}:${group.files[0] ?? 'multi'}×${payload.length}`, phase: 'Verify', schema: VERDICTS_SCHEMA },
  ).then((r) => { bump(group.verifier); for (const v of (r?.verdicts ?? [])) if (v?.id) verdictByKey.set(v.id, { verdict: v.verdict, lens: v.lens }); })
    .catch((e) => { notes.push(`verify group [${group.files.join(', ') || group.verifier}] failed: ${e.message}`); for (const p of payload) verdictByKey.set(p.id, { verdict: 'uncertain', lens: 'error' }); });
};

// +1 opus REVERIFY guard (the "N+1" agent). The batched refuters bias toward "refuted"; a wrongly
// refuted HOT finding is the costly miss. ONE extra opus agent re-examines only the refuted/uncertain
// findings that are hot or low-confidence, with the bias INVERTED — uphold as "real" unless the
// refutation clearly holds on the changed lines. Corrected verdicts overwrite the first pass. Skipped
// when nothing qualifies. Bounded input (only the at-risk subset), one agent.
const reverifyGuard = async (findings, verdictByKey) => {
  const atRisk = findings.filter((f) => {
    const v = verdictByKey.get(findingKey(f));
    if (!v || v.verdict === 'real') return false;   // only re-check what a refuter killed / left unsure
    return HOT_SEVERITIES.includes(f.severity) || (f.confidence ?? 0) < policy.reportConfidence || f.uncertain === true;
  });
  if (!atRisk.length) return findings;
  const payload = atRisk.map((f) => ({ ...verifyPayload(f), priorVerdict: verdictByKey.get(findingKey(f)).verdict }));
  const r = await agent(
    `A first verification pass REFUTED or left UNCERTAIN the finding(s) below — these are the ones most costly to MISS. Re-examine EACH for a FALSE NEGATIVE. For THIS pass invert the usual bias: uphold a finding as "real" unless the refutation clearly holds on the CHANGED lines (cite the concrete failing path); otherwise keep "refuted"/"uncertain". Return one verdict per finding, keyed by its "id". ${diffRead}\n\nFindings (with the prior verdict): ${JSON.stringify(payload)}.`,
    { agentType: pluginAgent('finding-verifier'), model: verifyModel, label: `reverify×${atRisk.length}`, phase: 'Verify', schema: VERDICTS_SCHEMA },
  ).then((res) => (bump('finding-verifier'), res)).catch((e) => { notes.push(`reverify guard failed: ${e.message}`); return null; });
  if (!r) return findings;
  const corrected = new Map((r.verdicts ?? []).filter((v) => v?.id).map((v) => [v.id, { verdict: v.verdict, lens: v.lens }]));
  return findings.map((f) => corrected.has(findingKey(f)) ? { ...f, verdict: corrected.get(findingKey(f)) } : f);
};

// Verify a finding set within a group budget: SELECT the unsure (selectForVerification), tag each with
// its verifier lens, GROUP into ≤budget groups, refute in parallel, apply verdicts, then (main pass
// only) run the +1 reverify guard. Returns findings with `.verdict` attached on the verified ones; the
// rest pass through untouched so resolveVerification([]) keeps them (trusted, confident findings).
const verifyFindings = async (findings, { budget, reverify }) => {
  if (!plan.runVerify || !findings.length) return findings;
  const selKeys = new Set(selectForVerification(findings, policy, { riskPaths }).map(findingKey));
  const tagged = findings.filter((f) => selKeys.has(findingKey(f))).map((f) => ({ ...f, verifier: verifierFor(f) }));
  if (!tagged.length) return findings;
  const verdictByKey = new Map();
  await parallel(groupForVerification(tagged, budget).map((g) => () => spawnBatchVerifier(g, verdictByKey)));
  const verified = findings.map((f) => verdictByKey.has(findingKey(f)) ? { ...f, verdict: verdictByKey.get(findingKey(f)) } : f);
  return reverify ? reverifyGuard(verified, verdictByKey) : verified;
};

// Re-dispatch a bounded, pre-capped (selectGaps) set of completeness gaps — shared by the exhaustive
// critic (≤6) and the high-tier screen (≤2). Each gap's named agent re-reviews with the full diff;
// only genuinely NEW findings (ledger-deduped against allFindings AT CALL TIME) survive and re-enter
// the batched Verify (own group budget, no reverify guard — the gap set is already tiny). Returns the
// verified-fresh findings for the caller to concat. Advisory — proposes, never edits.
async function reDispatchGaps(gaps, tag) {
  if (!gaps.length) return [];
  const seen = new Set(allFindings.map(findingKey));
  const reDispatched = await parallel(gaps.map((g) => () =>
    agent(
      `${packBlock}` +
      `Targeted re-review for a coverage gap (${g.kind}). Focus: ${g.dispatch.focus ?? g.what ?? ''}. Files: ${JSON.stringify(g.dispatch.files ?? [])}. ` +
      `Acceptance criteria: ${JSON.stringify(brief)}. Project rules: ${JSON.stringify(plan.projectRules)}. ${diffReadFor(g.dispatch.files)}`,
      // model PINNED to sonnet (see intent note): gap re-dispatch is a reviewer pass, not orchestration —
      // un-pinned it inherited the session model (opus). diffReadFor slices to the gap's files.
      { agentType: pluginAgent(g.dispatch.agent), model: 'sonnet', label: `gap:${g.kind}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ).then((r) => { bump(g.dispatch.agent); return r?.findings ?? []; })
      .catch((e) => { notes.push(`${tag} re-dispatch ${g.kind} failed: ${e.message}`); return []; })));
  const fresh = reDispatched.flat().filter((f) => !seen.has(findingKey(f)));
  return verifyFindings(fresh, { budget: policy.maxVerifierAgents, reverify: false });
}

// ONE review pass over an aspect. Prompt ordering is deliberate for prompt-cache reuse: the shared,
// byte-identical blocks (intent brief + project rules) lead so they cache across every aspect of the
// same reviewer agent; the per-aspect bits (shard diff, then the dim + file list) trail so they never
// poison that prefix. `pass` (1|2) tags the S7.1 double-run passes in the label; 0 = a single
// (non-exhaustive) run and adds no suffix. Returns raw {findings,strengths}, null on fail.
// An aspect now covers one AGENT's full dim set (a.dims). All dims sharing an agent share a model
// (the OPUS_DIMS D3/D7/D9 are each a distinct single-dim agent), so the group's model is the first
// resolved one. dimList drives the prompt/label; the label joins dims with '+' so "review:D1+D2+D12".
const reviewOnce = (a, pass) => {
  const dimList = (a.dims ?? []).join(', ');
  const dimTag = (a.dims ?? []).join('+');
  const model = (a.dims ?? []).map((d) => plan.models?.[d]).find(Boolean);
  return agent(
  `${reviewBlock}` +
  `${packBlock}` +
  `Acceptance criteria, mismatches + flagged intent groups (groups marked scrutinize warrant extra attention): ${JSON.stringify(brief)}. ` +
  `Project rules: ${JSON.stringify(plan.projectRules)}. ` +
  `The CONTEXT PACK above carries the enclosing definitions, imports, and in-repo callers — use it FIRST. Make at most 4 additional Read/Grep calls, only when the pack is insufficient for a specific suspected finding (name the suspicion in the finding's evidence); never read outside the changed files' directories except a directly named import.\n` +
  // COST LEVER (slicing): a reviewer reads only its files' diff slices; D3 (security) keeps the FULL
  // diff so cross-file taint source→sink survives (the aspect is unsharded over all files anyway).
  `${(a.dims ?? []).includes('D3') ? diffRead : diffReadFor(a.files)}\n\n` +
  `Review ONLY these changed files for dimension(s) ${dimList}: ${JSON.stringify(a.files)}.` +
  // S6.2/S6.3/S6.4: per-reviewer extras — correctness gets the cross-file consequence directive
  // + bug-history prior; test-adequacy gets the executed-test signal; others get ''.
  reviewerAddendum(a.agent, { history, testSignal }),
  { agentType: pluginAgent(a.agent), model, label: `review:${dimTag}:${a.shardId}${pass ? `#${pass}` : ''}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => { bump(a.agent); return { findings: r?.findings ?? [], strengths: r?.strengths ?? [] }; })
    .catch((e) => { notes.push(`review ${dimTag}/${a.shardId}${pass ? ` pass ${pass}` : ''} failed: ${e.message}`); return null; });
};

// S7.1: in exhaustive mode the correctness + vuln reviewers (the highest cost-of-miss) run TWICE — two
// INDEPENDENT passes unioned + deduped by findingKey (dedupeFindings), so a finding both passes agree
// on is verified once, not twice. Both passes bump the run count, so "Agents & coverage" shows the
// doubled dispatch. A failed pass degrades to nothing (never crashes the run).
const doubleRun = plan.discovery?.doubleRun === true;

// ONE review pass over an aspect (with the S7.1 double-run for the two highest cost-of-miss agents).
const reviewAspect = async (a) => {
  if (!(doubleRun && isDoubleRunAgent(a.agent))) {
    const r = await reviewOnce(a, 0);
    return r ? { aspect: a, findings: r.findings, strengths: r.strengths } : null;
  }
  const passes = await parallel([() => reviewOnce(a, 1), () => reviewOnce(a, 2)]);
  if (passes.every((p) => !p)) return null;
  return {
    aspect: a,
    findings: dedupeFindings(passes.flatMap((p) => p?.findings ?? [])),
    strengths: passes.flatMap((p) => p?.strengths ?? []),
  };
};

// Review is a BARRIER (parallel, not the old per-aspect pipeline): batched Verify needs EVERY finding
// at once to group by (lens, file) and cap agent count GLOBALLY — verifying per-aspect could not bound
// the total. Wall-clock cost is small (the review fan-out finishes close together; verify is a short
// tail). This is the legit barrier case: a global select/group/cap across the full result set.
const reviewed = await parallel(aspects.map((a) => () => reviewAspect(a)));
let allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings);
const allStrengths = reviewed.filter(Boolean).flatMap((r) => r.strengths ?? []);

// Batched verification over the full finding set: ≤ maxVerifierAgents sonnet-first groups (opus for a
// critical group + taint) + 1 opus reverify guard.
phase('Verify');
allFindings = await verifyFindings(allFindings, { budget: policy.maxVerifierAgents, reverify: true });

// ---------------------------------------------------------------- Tier C: completeness-critic (false-negative guard)
// Exhaustive (high/critical) reviews only. One bounded pass hunts for what the fan-out MISSED;
// each gap's named agent is re-dispatched (≤6), ledger-gated so only genuinely new findings are
// added, and those re-enter Verify before Resolve/Synthesize. Advisory — proposes, never edits.
if (plan.discovery?.completenessCritic) {
  // Digest, not the full findings: the critic checks WHICH criteria/dimensions have a finding and
  // whether an asserted claim was verified — it never re-reads the prose evidence/fix. Keep verdict
  // (its unverified-claim gate) + dimension (missing-dimension gate); drop evidence/fix (the bulky
  // fields). Full evidence/fix still reach the synthesizer via resolved.report — no traceability loss.
  const findingsDigest = allFindings.map((f) => ({
    file: f.file, line: f.line, title: f.title, dimension: f.dimension,
    severity: f.severity, confidence: f.confidence, verdict: f.verdict,
  }));
  const critic = await agent(
    `${reviewBlock}` +
    `Hunt for what this review MISSED — do NOT re-review everything. Dimensions that ran: ${JSON.stringify([...(plan.dimensions ?? []), ...triageExtraDims])}. ` +
    `Acceptance criteria + coverage: ${JSON.stringify(intent)}. Kept findings: ${JSON.stringify(findingsDigest)}. ` +
    `Risk paths: ${JSON.stringify(plan.signals?.riskPaths ?? [])}. Project rules: ${JSON.stringify(plan.projectRules)}. ` +
    `Changed files: ${JSON.stringify(plan.files)}. Diff summary: ${plan.diffSummary}. ${diffRead}`,
    { agentType: pluginAgent('completeness-critic'), model: 'opus', label: 'completeness-critic', phase: 'Verify', schema: GAPS_SCHEMA },
  ).then((r) => (bump('completeness-critic'), r)).catch((e) => { notes.push(`completeness-critic failed: ${e.message}`); return null; });

  if (critic?.assessment) notes.push(`completeness-critic: ${critic.assessment}`);
  allFindings = allFindings.concat(await reDispatchGaps(selectGaps(critic?.gaps, 6), 'completeness'));
}

// ---------------------------------------------------------------- Tier B: completeness SCREEN (every workflow tier, cheap)
// S6.1 of plan.md. A CHEAP x1 false-negative screen on EVERY workflow tier (low/standard/high) —
// haiku, no diff — run only when the full exhaustive critic above did NOT (they never both run; the
// critic supersedes it at critical/--exhaustive). It sees coverage metadata ONLY — which dimensions
// ran, the finding titles, and the raw intent-analyzer output — but NO diff, so it flags
// dimension/criterion COVERAGE gaps and CANNOT claim untraced-taint. A gap naming an unrun dimension
// re-dispatches a per-tier-capped set of targeted reviewers (screenGapCap: low 0 / standard 1 / high 2,
// vs the exhaustive critic's 6), whose new findings re-enter Verify. Advisory — proposes, never edits.
if (plan.discovery?.completenessScreen) {
  const packet = screenPacket({ plan, findings: allFindings, intent, extraDims: triageExtraDims });
  const screen = await agent(
    `Coverage SCREEN (mode: screen) — you see NO diff, only coverage metadata. Flag at most 3 dimension/criterion COVERAGE gaps: an acceptance criterion with no matching finding, or a dimension that should have run but did not. Do NOT claim untraced-taint or any diff-level gap. ${JSON.stringify(packet)}`,
    { agentType: pluginAgent('completeness-critic'), model: 'haiku', label: 'completeness-screen', phase: 'Verify', schema: GAPS_SCHEMA },
  ).then((r) => (bump('completeness-critic'), r)).catch((e) => { notes.push(`completeness-screen failed: ${e.message}`); return null; });

  if (screen?.assessment) notes.push(`completeness-screen: ${screen.assessment}`);
  // Gap re-dispatch budget follows blast radius (plan.discovery.screenGapCap): low=0 (haiku screen
  // only, no re-dispatch), standard=1, high=2. cap 0 → selectGaps returns [] → reDispatchGaps no-ops.
  allFindings = allFindings.concat(await reDispatchGaps(selectGaps(screen?.gaps, plan.discovery?.screenGapCap ?? 0), 'completeness-screen'));
}

// ---------------------------------------------------------------- Resolve (deterministic, inline — no agent)
// Pure verdict resolution: run it here instead of spawning an executor agent. Verdicts are
// kept as { verdict, lens } only (matching the previous executor input) so behavior is identical.
phase('Synthesize');
let resolved;
try {
  const resolvedList = allFindings.map((f) => resolveVerification(f, f.verdict ? [{ verdict: f.verdict.verdict, lens: f.verdict.lens }] : [], policy));
  const part = partition(resolvedList, policy);
  resolved = { ...part, summary: `verified ${resolvedList.filter((f) => f.verify?.passes > 1).length} finding(s): ${part.report.length} kept, ${part.dropped.length} refuted, ${part.needsHuman.length} need human (cap ${policy.maxPassesPerAspect} looks/aspect)` };
} catch (e) {
  notes.push(`resolve failed: ${e.message}`);
  resolved = { report: allFindings, dropped: [], needsHuman: [], summary: {} };
}

// ---------------------------------------------------------------- Synthesize
const synth = await agent(
  `Aggregate into one deduped, severity-ranked review with a per-criterion traceability matrix. ` +
  `Acceptance criteria: ${JSON.stringify(intent)}. Kept findings: ${JSON.stringify(resolved.report)}. ` +
  `Strengths seen: ${JSON.stringify(allStrengths)}. Business-logic open questions: ${JSON.stringify(intent?.openQuestions ?? [])}.`,
  // model PINNED to sonnet (see intent note): un-pinned it inherits the session model → opus.
  { agentType: pluginAgent('review-synthesizer'), model: 'sonnet', phase: 'Synthesize', schema: SYNTH_SCHEMA },
).then((r) => (bump('review-synthesizer'), r));

// Inline PR comments are built + posted deterministically by lib/comments.mjs from the
// command (step 5) when --comment is set; no agent pass is needed here.

// ---------------------------------------------------------------- Report payload (rendered by the COMMAND)
// No executor agent here: the workflow sandbox can't write files, and broadcasting this whole
// payload to a haiku agent that only shells out to report.mjs is pure input-token waste. Assemble
// the payload and hand it back; /review step 5 runs `node report.mjs` directly (it reads
// {folderPath, verdict} from stdout). report.mjs still enforces the plan/agentRuns invariant.
// Diff-scope demotion: split the synthesized findings into in-diff (gate-affecting) and
// out-of-diff (advisory-only). Only the in-diff set feeds the verdict/gate/comments; the
// demoted set is rendered in its own "Out-of-scope observations" section (S1.1 of plan.md).
const { inScope: scopedFindings, outOfDiff } = partitionByScope(synth.findings ?? [], diffIndex ?? {}, plan.diffScope?.slack ?? 3);
if (outOfDiff.length) notes.push(`${outOfDiff.length} finding(s) anchored outside the change — demoted to advisory (not gated)`);

const payload = {
  findings: scopedFindings,
  outOfDiff,
  criteria: synth.criteria ?? [],
  tier: plan.tier, gate: plan.gate,
  needsHuman: [...(synth.needsHuman ?? []), ...(resolved.needsHuman ?? [])],
  skipped: synth.skipped ?? [], strengths: synth.strengths ?? [],
  summary: synth.summary ?? '', summaryPoints: synth.summaryPoints ?? [],
  context: { pr: bundle?.pr, tickets: bundle?.tickets, existingComments: bundle?.existingComments, trackerUsage: bundle?.trackerUsage },
  verify: resolved.summary ?? {},
  plan, agentRuns,
  commentMode: flags?.comment === true,
  // S9: incremental review — signals report.mjs to dedupe findings against the previous run's
  // last-review.json (new-vs-carried-over) and re-key the sha-keyed state. Diff narrowing itself
  // happens deterministically in plan.mjs (prevHead..head, fail-open on non-fast-forward).
  incremental: flags?.incremental === true,
  startedAt: startedAt ?? null, prNumber: prNumber ?? null, checkout: checkout ?? null,
  testSignal: testSignal ?? null,   // S6.4: executed-test signal → report header (null unless --run-tests)
  learningStore: plan.learning?.store ?? null, range: plan.range ?? null,
};

return { payload, needsHuman: payload.needsHuman, notes };
