export const meta = {
  name: 'acr-review',
  description: 'Adversarial code review fan-out: intent, per-aspect review, per-finding verify, synthesize, render.',
  phases: [
    { title: 'Intent' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
};

// --- inlined pure helpers (canonical + tested: lib/review-orchestration.mjs) ---
const findingKey = (f = {}) => `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
function expandAspects(dimensionAgents = {}, shards = []) {
  const list = shards.length ? shards : [{ label: 'all', files: [] }];
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    for (const s of list) out.push({ dim, agent, shardId: s.label, files: s.files ?? [] });
  }
  return out;
}
const newCaps = () => ({});
const canSpawn = (caps, key, max = 3) => (caps[key] ?? 0) < max;
const recordSpawn = (caps, key) => { caps[key] = (caps[key] ?? 0) + 1; };

// --- inlined diff-trim (canonical + tested: lib/trim-diff.mjs) ---
// Scope a dimension reviewer's diff to its shard files only — the diff is the single dominant
// input-token cost. Whole sections kept verbatim; any parse anomaly or total miss falls back to
// the full diff so a reviewer is NEVER handed a short/empty diff (an invisible false-negative).
const normPath = (p) => (typeof p !== 'string' ? '' : p.split('\t')[0].replace(/^[ab]\//, '').trim());
function sectionPath(text) {
  const plus = /^\+\+\+ (.+)$/m.exec(text);
  if (plus && plus[1].trim() !== '/dev/null') return normPath(plus[1]);
  const minus = /^--- (.+)$/m.exec(text);
  if (minus && minus[1].trim() !== '/dev/null') return normPath(minus[1]);
  const git = /^diff --git a\/(.+) b\/(.+)$/m.exec(text);
  if (git) return normPath(git[2]);
  return '';
}
function filterDiff(diff, files) {
  if (typeof diff !== 'string' || diff === '') return diff;
  const wanted = new Set((files ?? []).map(normPath).filter(Boolean));
  if (wanted.size === 0) return diff;
  const sections = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))
    .map((text) => ({ text, path: sectionPath(text) }));
  if (sections.length === 0) return diff;
  const kept = sections.filter((s) => s.path && wanted.has(s.path));
  if (kept.length === 0) return diff;
  return kept.map((s) => s.text).join('');
}
// Drop mechanically-generated / vendored sections (lockfiles, build artifacts, sourcemaps,
// snapshots) the plan already excludes from `files` — the raw diff still carries their huge hunks.
// Applied ONLY to the Intent-phase agents (harvester/business-logic): none review a
// lockfile, and it removes no source/test/config hunk, so it cannot starve a real reviewer. Same
// fallback-to-full-diff invariant as filterDiff. Canonical + tested: lib/trim-diff.mjs.
const NOISE_RE = /(^|\/)(dist|build|out|coverage|node_modules)\/|\.(lock|min\.js|map|snap|pb\.go)$|(^|\/)package-lock\.json$/i;
function stripNoise(diff) {
  if (typeof diff !== 'string' || diff === '') return diff;
  const sections = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith('diff --git '))
    .map((text) => ({ text, path: sectionPath(text) }));
  if (sections.length === 0) return diff;
  const kept = sections.filter((s) => !s.path || !NOISE_RE.test(s.path));
  if (kept.length === 0 || kept.length === sections.length) return diff;
  return kept.map((s) => s.text).join('');
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
const DEFAULT_VERIFY = { maxPassesPerAspect: 3, maxSubagentsPerAspect: 3, reverifyBelow: 80, reportConfidence: 80, escalateUncertain: true, modelFirst: 'sonnet', modelEscalate: 'opus', escalateDirectSeverity: ['critical'] };
const HOT_SEVERITIES = ['critical', 'important', 'high'];
// Cheap→strong verifier routing (canonical + tested: lib/verify.mjs firstPassModel/shouldEscalate).
// firstPassModel: critical findings skip the cheap pass and go straight to the strong model.
function firstPassModel(finding = {}, policy = DEFAULT_VERIFY) {
  const direct = new Set(policy.escalateDirectSeverity ?? DEFAULT_VERIFY.escalateDirectSeverity);
  return direct.has(finding.severity) ? policy.modelEscalate : policy.modelFirst;
}
// shouldEscalate: after a cheap pass, escalate to the strong model on uncertain, or on a refute of a
// hot finding (never drop a hot finding on a single cheap refuter). The strong verdict then wins.
function shouldEscalate(finding = {}, verdict, policy = DEFAULT_VERIFY) {
  const v = (verdict && typeof verdict === 'object') ? verdict.verdict : verdict;
  if (v === 'uncertain') return true;
  if (v === 'refuted' && HOT_SEVERITIES.includes(finding.severity)) return true;
  return false;
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
    file: { type: 'string' }, line: { type: 'number' }, title: { type: 'string' },
    evidence: { type: 'string' }, fix: { type: 'string' }, confidence: { type: 'number' },
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
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { enum: ['real', 'refuted', 'uncertain'] }, lens: { type: 'string' },
    rationale: { type: 'string' }, confidence: { type: 'number' },
  },
  required: ['verdict'],
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
const { plan, bundle, diff, shards, routing, flags, startedAt, prNumber, checkout } = A;
// Intent-phase agents reason about WHAT changed, not lockfile/build-artifact churn — strip the
// noise sections the plan already dropped from `files`. Reviewers/verifiers/critic keep the full
// `diff` (they shard-scope it themselves; D15 still needs raw manifests).
const intentDiff = stripNoise(diff);
const notes = [];
const agentRuns = {};
const caps = newCaps();
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
// Skip the triage judgment pass for TRIVIAL only: dimensions are fixed (D2+D13) and verify/critic
// are off, so a judgment-based dimension add is the lowest-value call there. low+ KEEPS it — that
// is where it catches a small diff that quietly disables a security control with no signal glob to
// flag it. triage=null is already handled downstream (render + the extra-dims loop). `plan.models`
// is intentionally omitted from the prompt: triage judges blast radius/tier, never model assignment.
let triage = null;
if (plan.tier !== 'trivial') {
  triage = await agent(
    `Sanity-check this review tier using judgment about blast radius. Signals: ${JSON.stringify(plan.signals)}. ` +
    `Draft plan — tier: ${plan.tier}, dimensions: ${JSON.stringify(plan.dimensions)}. ` +
    `Changed files: ${JSON.stringify(plan.files)}. Diff summary: ${plan.diffSummary}.`,
    { agentType: pluginAgent('triage-classifier'), model: 'haiku', label: 'triage', phase: 'Intent', schema: TRIAGE_SCHEMA },
  ).then((r) => (bump('triage-classifier'), r)).catch((e) => { notes.push(`triage-classifier failed: ${e.message}`); return null; });
}

const triageExtraDims = [];
if (triage) {
  if ((TIER_RANK[triage.tier] ?? -1) > (TIER_RANK[plan.tier] ?? -1)) {
    notes.push(`triage-classifier suggests tier ${triage.tier} > computed ${plan.tier}: ${triage.reason ?? ''}`);
  }
  for (const d of triage.addDimensions ?? []) {
    if (!(plan.dimensions ?? []).includes(d) && (plan.dimensionAgentsAll ?? {})[d] && !triageExtraDims.includes(d)) triageExtraDims.push(d);
  }
}

// ---------------------------------------------------------------- Intent
// Diff FIRST so the (noise-stripped) intent diff is a byte-identical prefix shared by both intent
// calls — it prompt-caches across them, so the dominant diff input is paid ~once (the same
// diff-first trick the verify pass uses). intent-harvester ALSO clusters intent groups now (the
// former intent-grouper, folded in): one pass yields the whole intent model — criteria, mismatches,
// and primary/extra groups — so `harvester` carries the groups the dimension reviewers consume.
const harvester = await agent(
  `Diff:\n${intentDiff}\n\nBuild the acceptance-criteria model for this change AND cluster the diff into intent groups (primary vs EXTRA), flagging the groups that need scrutiny. Context: ${JSON.stringify(basePacket)}. Diff summary: ${plan.diffSummary}.`,
  { agentType: pluginAgent('intent-harvester'), phase: 'Intent' },
).then((r) => (bump('intent-harvester'), r));

// business-logic depends on the harvested criteria, so it runs after (it no longer overlaps the
// grouping, which is now part of the harvester pass). Shares the same diff-first cacheable prefix.
const businessLogic = plan.tier === 'low'
  ? null
  : await agent(
    `Diff:\n${intentDiff}\n\nModel the domain/business logic; list assumptions + OPEN QUESTIONS (do not guess on material ambiguity). Criteria + intent groups: ${JSON.stringify(harvester)}.`,
    { agentType: pluginAgent('business-logic-analyzer'), phase: 'Intent' },
  ).then((r) => (bump('business-logic-analyzer'), r));

// ---------------------------------------------------------------- Review → Verify (pipeline, no barrier)
phase('Review');
// plan.verify is ALREADY RESOLVED (camelCase) by plan.mjs — merge it over the defaults and re-derive
// the cap. Do NOT re-resolve via cleanVerify (it maps only raw snake_case config, so it would silently
// revert every customized field — reverify_below, the escalation models — back to its default).
const policy = { ...DEFAULT_VERIFY, ...(plan.verify ?? {}) };
policy.maxVerifierPasses = Math.max(0, Math.min(policy.maxPassesPerAspect - 1, policy.maxSubagentsPerAspect));
const riskPaths = plan.signals?.riskPaths ?? [];
const aspects = expandAspects(plan.dimensionAgents, shards);
// extra-intent scrutiny + mandatory checks become additional aspects (computed in the main agent via route.mjs)
for (const t of routing?.scrutiny?.targets ?? []) aspects.push({ dim: t.label, agent: 'correctness-reviewer', shardId: 'scrutiny', files: t.files });
// dimensions triage-classifier judged were missed → real aspects (reviewed + verified like any other)
for (const d of triageExtraDims) aspects.push({ dim: d, agent: plan.dimensionAgentsAll[d], shardId: 'triage', files: plan.files ?? [] });

// Rank-1 token lever: a dimension reviewer is told to "Review ONLY these files" yet today gets the
// WHOLE diff. Scope it to the aspect's shard files — but ONLY when sharded and the aspect has a
// concrete file subset, and NEVER for D3 (security needs the full diff so cross-file taint
// source→sink survives). filterDiff falls back to the full diff on any parse anomaly. The
// completeness-critic and gap re-dispatch deliberately stay on the full diff (cross-file refutation).
const sharded = Array.isArray(shards) && shards.length > 0;
const diffForAspect = (a) =>
  (sharded && a.dim !== 'D3' && Array.isArray(a.files) && a.files.length > 0)
    ? filterDiff(diff, a.files)
    : diff;

// Same lever for the per-finding verify pass: a finding-verifier is refuting ONE finding, so it only
// needs that finding's own file hunks — file-scope the diff (filterDiff falls back to the full diff
// on any path miss, so the verifier is never starved). The taint-verifier (D3) is the exception and
// KEEPS the full diff: refuting a security finding means following an untrusted source→sink across
// files, which a single-file slice would hide (same reason D3 reviewers stay unsharded above).
const verifierDiff = (f, verifier) =>
  verifier === 'taint-verifier' ? diff : filterDiff(diff, [f.file]);

// One verifier pass on a chosen model. Diff is file-SCOPED per finding (verifierDiff) — the larger
// raw-token cut. Diff-first ordering keeps that prefix prompt-cacheable across findings that share a
// scope (same file, or all taint findings on the full diff); the per-finding JSON trails so it never
// poisons the prefix. A failed pass degrades to an 'uncertain' verdict (never crashes the run).
const spawnVerifier = (f, verifier, model) =>
  agent(
    `Diff:\n${verifierDiff(f, verifier)}\n\nAdversarially REFUTE this finding by reading the actual code path. Finding: ${JSON.stringify(f)}.`,
    { agentType: pluginAgent(verifier), model, label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => { bump(verifier); return v; })
    .catch((e) => { notes.push(`verify ${f.file}:${f.line} failed: ${e.message}`); return { verdict: 'uncertain', lens: 'error' }; });

// Cheap→strong escalation for ONE finding. firstPassModel picks the model (strong directly for
// critical); an uncertain/hot-refuted cheap verdict escalates to the strong model, whose verdict is
// then AUTHORITATIVE — the cheap one is discarded. `gate()` bounds the 2nd pass against the per-aspect
// subagent cap (pass null where the caller already bounds the finding set, e.g. completeness gaps).
async function verifyWithEscalation(f, gate) {
  const verifier = (f.dimension === 'D3' && plan.discovery?.taint) ? 'taint-verifier' : 'finding-verifier';
  const m1 = firstPassModel(f, policy);
  const v1 = await spawnVerifier(f, verifier, m1);
  if (m1 !== policy.modelEscalate && shouldEscalate(f, v1, policy) && (!gate || gate())) {
    const v2 = await spawnVerifier(f, verifier, policy.modelEscalate);
    return { ...f, verdict: v2 };
  }
  return { ...f, verdict: v1 };
}

const reviewed = await pipeline(
  aspects,
  // stage 1: review one aspect
  (a) => agent(
    `Review ONLY these changed files for dimension ${a.dim}: ${JSON.stringify(a.files)}. ` +
    `Acceptance criteria, mismatches + intent groups (EXTRA groups flagged scrutinize warrant extra attention): ${JSON.stringify(harvester)}. ` +
    `Project rules: ${JSON.stringify(plan.projectRules)}. ` +
    `Use Read/Grep to pull any sibling or imported context the diff does not show. Diff:\n${diffForAspect(a)}`,
    { agentType: pluginAgent(a.agent), model: plan.models?.[a.dim], label: `review:${a.dim}:${a.shardId}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => { bump(a.agent); return { aspect: a, findings: r?.findings ?? [], strengths: r?.strengths ?? [] }; })
    .catch((e) => { notes.push(`review ${a.dim}/${a.shardId} failed: ${e.message}`); return null; }),
  // stage 2: verify ONLY the unsure findings (selectForVerification); confident, non-risk
  // findings are trusted and carried through unverified (resolveVerification([]) keeps them).
  (rev) => {
    if (!rev || !plan.runVerify) return rev;
    const toVerify = new Set(selectForVerification(rev.findings, policy, { riskPaths }).map(findingKey));
    const max = plan.verify?.maxSubagentsPerAspect ?? 3;
    return parallel(rev.findings.map((f) => () => {
      if (!toVerify.has(findingKey(f))) return Promise.resolve(f);
      const key = `verify:${findingKey(f)}`;
      if (!canSpawn(caps, key, max)) return Promise.resolve({ ...f, verdict: { verdict: 'uncertain', lens: 'capped' } });
      recordSpawn(caps, key);                                   // first-pass budget
      // gate() spends the next per-aspect spawn for the escalation pass, or denies it at the cap.
      const gate = () => { if (!canSpawn(caps, key, max)) return false; recordSpawn(caps, key); return true; };
      return verifyWithEscalation(f, gate);
    })).then((verified) => ({ ...rev, findings: verified }));
  },
);

let allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings);
const allStrengths = reviewed.filter(Boolean).flatMap((r) => r.strengths ?? []);

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
    `Hunt for what this review MISSED — do NOT re-review everything. Dimensions that ran: ${JSON.stringify([...(plan.dimensions ?? []), ...triageExtraDims])}. ` +
    `Acceptance criteria + coverage: ${JSON.stringify(harvester)}. Kept findings: ${JSON.stringify(findingsDigest)}. ` +
    `Risk paths: ${JSON.stringify(plan.signals?.riskPaths ?? [])}. Project rules: ${JSON.stringify(plan.projectRules)}. ` +
    `Changed files: ${JSON.stringify(plan.files)}. Diff summary: ${plan.diffSummary}. Diff:\n${diff}`,
    { agentType: pluginAgent('completeness-critic'), model: 'opus', label: 'completeness-critic', phase: 'Verify', schema: GAPS_SCHEMA },
  ).then((r) => (bump('completeness-critic'), r)).catch((e) => { notes.push(`completeness-critic failed: ${e.message}`); return null; });

  if (critic?.assessment) notes.push(`completeness-critic: ${critic.assessment}`);
  const gaps = (critic?.gaps ?? []).filter((g) => g?.dispatch?.agent).slice(0, 6);
  if (gaps.length) {
    const seen = new Set(allFindings.map(findingKey));
    const reDispatched = await parallel(gaps.map((g) => () =>
      agent(
        `Targeted re-review for a coverage gap (${g.kind}). Focus: ${g.dispatch.focus ?? g.what ?? ''}. Files: ${JSON.stringify(g.dispatch.files ?? [])}. ` +
        `Acceptance criteria: ${JSON.stringify(harvester)}. Project rules: ${JSON.stringify(plan.projectRules)}. Diff:\n${diff}`,
        { agentType: pluginAgent(g.dispatch.agent), label: `gap:${g.kind}`, phase: 'Review', schema: FINDINGS_SCHEMA },
      ).then((r) => { bump(g.dispatch.agent); return r?.findings ?? []; })
        .catch((e) => { notes.push(`completeness re-dispatch ${g.kind} failed: ${e.message}`); return []; })));
    const fresh = reDispatched.flat().filter((f) => !seen.has(findingKey(f)));
    // re-enter Verify with the same cheap→strong escalation. The fresh set is already bounded (≤6
    // gaps), so the escalation pass is unbounded here (gate=null) — at most 2 looks per fresh finding.
    const verifiedFresh = await parallel(fresh.map((f) => () => {
      if (!plan.runVerify) return Promise.resolve(f);
      return verifyWithEscalation(f, null);
    }));
    allFindings = allFindings.concat(verifiedFresh);
  }
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
  `Acceptance criteria: ${JSON.stringify(harvester)}. Kept findings: ${JSON.stringify(resolved.report)}. ` +
  `Strengths seen: ${JSON.stringify(allStrengths)}. Business-logic open questions: ${JSON.stringify(businessLogic)}.`,
  { agentType: pluginAgent('review-synthesizer'), phase: 'Synthesize', schema: SYNTH_SCHEMA },
).then((r) => (bump('review-synthesizer'), r));

// Inline PR comments are built + posted deterministically by lib/comments.mjs from the
// command (step 5) when --comment is set; no agent pass is needed here.

// ---------------------------------------------------------------- Report payload (rendered by the COMMAND)
// No executor agent here: the workflow sandbox can't write files, and broadcasting this whole
// payload to a haiku agent that only shells out to report.mjs is pure input-token waste. Assemble
// the payload and hand it back; /review step 5 runs `node report.mjs` directly (it reads
// {folderPath, verdict} from stdout). report.mjs still enforces the plan/agentRuns invariant.
const payload = {
  findings: synth.findings ?? [],
  criteria: synth.criteria ?? [],
  tier: plan.tier, gate: plan.gate,
  needsHuman: [...(synth.needsHuman ?? []), ...(resolved.needsHuman ?? [])],
  skipped: synth.skipped ?? [], strengths: synth.strengths ?? [],
  summary: synth.summary ?? '', summaryPoints: synth.summaryPoints ?? [],
  context: { pr: bundle?.pr, tickets: bundle?.tickets, existingComments: bundle?.existingComments, trackerUsage: bundle?.trackerUsage },
  verify: resolved.summary ?? {},
  plan, agentRuns,
  commentMode: flags?.comment === true,
  startedAt: startedAt ?? null, prNumber: prNumber ?? null, checkout: checkout ?? null,
  learningStore: plan.learning?.store ?? null, range: plan.range ?? null,
};

return { payload, needsHuman: payload.needsHuman, notes };
