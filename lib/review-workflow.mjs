export const meta = {
  name: 'acr-review',
  description: 'Adversarial code review fan-out: intent, per-aspect review, per-finding verify, synthesize, render.',
  phases: [
    { title: 'Intent' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
    { title: 'Report' },
  ],
};

// --- inlined pure helpers (canonical + tested: lib/review-orchestration.mjs) ---
const findingKey = (f = {}) => `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
function expandAspects(dimensionAgents = {}, shards = []) {
  const list = shards.length ? shards : [{ id: 'all', files: [] }];
  const out = [];
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    for (const s of list) out.push({ dim, agent, shardId: s.id, files: s.files ?? [] });
  }
  return out;
}
const newCaps = () => ({});
const canSpawn = (caps, key, max = 3) => (caps[key] ?? 0) < max;
const recordSpawn = (caps, key) => { caps[key] = (caps[key] ?? 0) + 1; };
// Plugin agents register namespaced (adversarial-code-review:<name>); a bare name
// only resolves on the plugin's own repo. Resolve every bundled agentType through this.
const pluginAgent = (t) => (!t || t === 'general-purpose' || t.includes(':') ? t : `adversarial-code-review:${t}`);

// --- schemas (force structured sub-agent output) ---
const FINDING = {
  type: 'object',
  properties: {
    dimension: { type: 'string' }, severity: { enum: ['critical', 'important', 'minor', 'suggestion'] },
    file: { type: 'string' }, line: { type: 'number' }, title: { type: 'string' },
    evidence: { type: 'string' }, fix: { type: 'string' }, confidence: { type: 'number' },
    uncertain: { type: 'boolean' },
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
    summary: { type: 'string' }, strengths: { type: 'array', items: { type: 'string' } },
    criteria: { type: 'array' }, findings: { type: 'array', items: FINDING },
    needsHuman: { type: 'array' }, skipped: { type: 'array' },
  },
  required: ['findings'],
};

// args arrives as a JSON STRING (confirmed via spike), not a parsed object — parse defensively.
const A = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
const { lib, plan, bundle, diff, shards, routing, flags, startedAt, prNumber, worktrees } = A;
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
const triage = await agent(
  `Sanity-check this review tier using judgment about blast radius. Signals: ${JSON.stringify(plan.signals)}. ` +
  `Draft plan — tier: ${plan.tier}, dimensions: ${JSON.stringify(plan.dimensions)}, models: ${JSON.stringify(plan.models)}. ` +
  `Changed files: ${JSON.stringify(plan.files)}. Diff summary: ${plan.diffSummary}.`,
  { agentType: pluginAgent('triage-classifier'), model: 'haiku', label: 'triage', phase: 'Intent', schema: TRIAGE_SCHEMA },
).then((r) => (bump('triage-classifier'), r)).catch((e) => { notes.push(`triage-classifier failed: ${e.message}`); return null; });

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
const harvester = await agent(
  `Build the acceptance-criteria model for this change. Context: ${JSON.stringify(basePacket)}. Diff summary: ${plan.diffSummary}. Diff:\n${diff}`,
  { agentType: pluginAgent('intent-harvester'), phase: 'Intent' },
).then((r) => (bump('intent-harvester'), r));

const [grouper, businessLogic] = await parallel([
  () => agent(
    `Cluster this diff into intent groups (primary vs EXTRA), flag groups needing scrutiny. Criteria: ${JSON.stringify(harvester)}. Diff:\n${diff}`,
    { agentType: pluginAgent('intent-grouper'), phase: 'Intent' },
  ).then((r) => (bump('intent-grouper'), r)),
  () => (plan.tier === 'low'
    ? Promise.resolve(null)
    : agent(
      `Model the domain/business logic; list assumptions + OPEN QUESTIONS (do not guess on material ambiguity). Criteria: ${JSON.stringify(harvester)}. Diff:\n${diff}`,
      { agentType: pluginAgent('business-logic-analyzer'), phase: 'Intent' },
    ).then((r) => (bump('business-logic-analyzer'), r))),
]);

// ---------------------------------------------------------------- Review → Verify (pipeline, no barrier)
phase('Review');
const aspects = expandAspects(plan.dimensionAgents, shards);
// extra-intent scrutiny + mandatory checks become additional aspects (computed in the main agent via route.mjs)
for (const t of routing?.scrutiny?.targets ?? []) aspects.push({ dim: t.label, agent: 'correctness-reviewer', shardId: 'scrutiny', files: t.files });
// dimensions triage-classifier judged were missed → real aspects (reviewed + verified like any other)
for (const d of triageExtraDims) aspects.push({ dim: d, agent: plan.dimensionAgentsAll[d], shardId: 'triage', files: plan.files ?? [] });

const reviewed = await pipeline(
  aspects,
  // stage 1: review one aspect
  (a) => agent(
    `Review ONLY these changed files for dimension ${a.dim}: ${JSON.stringify(a.files)}. ` +
    `Acceptance criteria + mismatches: ${JSON.stringify(harvester)}. Relevant intent groups: ${JSON.stringify(grouper)}. ` +
    `Project rules: ${JSON.stringify(plan.projectRules)}. Diff:\n${diff}`,
    { agentType: pluginAgent(a.agent), model: plan.models?.[a.dim], label: `review:${a.dim}:${a.shardId}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => { bump(a.agent); return { aspect: a, findings: r?.findings ?? [], strengths: r?.strengths ?? [] }; })
    .catch((e) => { notes.push(`review ${a.dim}/${a.shardId} failed: ${e.message}`); return null; }),
  // stage 2: verify EVERY finding from this aspect, each in its own agent (verify-all)
  (rev) => {
    if (!rev || !plan.runVerify) return rev;
    return parallel(rev.findings.map((f) => () => {
      const key = `verify:${findingKey(f)}`;
      if (!canSpawn(caps, key, plan.verify?.maxSubagentsPerAspect ?? 3)) return Promise.resolve({ ...f, verdict: { verdict: 'uncertain', lens: 'capped' } });
      recordSpawn(caps, key);
      const isSecurity = (f.dimension === 'D3') && plan.discovery?.taint;
      const verifier = isSecurity ? 'taint-verifier' : 'finding-verifier';
      return agent(
        `Adversarially REFUTE this finding by reading the actual code path. Finding: ${JSON.stringify(f)}. Diff:\n${diff}`,
        { agentType: pluginAgent(verifier), label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => { bump(verifier); return { ...f, verdict: v }; })
        .catch((e) => { notes.push(`verify ${f.file}:${f.line} failed: ${e.message}`); return { ...f, verdict: { verdict: 'uncertain', lens: 'error' } }; });
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
  const critic = await agent(
    `Hunt for what this review MISSED — do NOT re-review everything. Dimensions that ran: ${JSON.stringify([...(plan.dimensions ?? []), ...triageExtraDims])}. ` +
    `Acceptance criteria + coverage: ${JSON.stringify(harvester)}. Kept findings: ${JSON.stringify(allFindings)}. ` +
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
    // re-enter Verify: each fresh finding gets its own refute pass (taint-verifier for D3 when exhaustive)
    const verifiedFresh = await parallel(fresh.map((f) => () => {
      if (!plan.runVerify) return Promise.resolve(f);
      const verifier = (f.dimension === 'D3' && plan.discovery?.taint) ? 'taint-verifier' : 'finding-verifier';
      return agent(
        `Adversarially REFUTE this finding by reading the actual code path. Finding: ${JSON.stringify(f)}. Diff:\n${diff}`,
        { agentType: pluginAgent(verifier), label: `verify:${f.file}:${f.line}`, phase: 'Verify', schema: VERDICT_SCHEMA },
      ).then((v) => { bump(verifier); return { ...f, verdict: v }; })
        .catch((e) => { notes.push(`verify ${f.file}:${f.line} failed: ${e.message}`); return { ...f, verdict: { verdict: 'uncertain', lens: 'error' } }; });
    }));
    allFindings = allFindings.concat(verifiedFresh);
  }
}

// ---------------------------------------------------------------- Resolve (deterministic script via executor agent)
phase('Synthesize');
const resolveInput = JSON.stringify({
  findings: allFindings.map((f) => ({ ...f, verdicts: f.verdict ? [{ verdict: f.verdict.verdict, lens: f.verdict.lens }] : [] })),
  config: { verify: plan.verify },
});
const resolved = await agent(
  `Run this EXACT command from the repo root and return ONLY its stdout JSON, nothing else:\n` +
  `cat <<'ACR_EOF' | node "${lib}/verify.mjs" resolve\n${resolveInput}\nACR_EOF`,
  { agentType: 'general-purpose', label: 'resolve', phase: 'Synthesize', schema: { type: 'object', properties: { report: { type: 'array' }, dropped: { type: 'array' }, needsHuman: { type: 'array' }, summary: { type: 'object' } }, required: ['report'] } },
).catch((e) => { notes.push(`resolve failed: ${e.message}`); return { report: allFindings, dropped: [], needsHuman: [], summary: {} }; });

// ---------------------------------------------------------------- Synthesize
const synth = await agent(
  `Aggregate into one deduped, severity-ranked review with a per-criterion traceability matrix. ` +
  `Acceptance criteria: ${JSON.stringify(harvester)}. Kept findings: ${JSON.stringify(resolved.report)}. ` +
  `Strengths seen: ${JSON.stringify(allStrengths)}. Business-logic open questions: ${JSON.stringify(businessLogic)}.`,
  { agentType: pluginAgent('review-synthesizer'), phase: 'Synthesize', schema: SYNTH_SCHEMA },
).then((r) => (bump('review-synthesizer'), r));

if (flags?.comment) {
  await agent(`Turn these kept findings into inline PR comment objects: ${JSON.stringify(synth.findings)}`,
    { agentType: pluginAgent('pr-comment-author'), phase: 'Synthesize' }).then(() => bump('pr-comment-author')).catch((e) => notes.push(`pr-comment-author failed: ${e.message}`));
}

// ---------------------------------------------------------------- Report (deterministic script via executor agent)
phase('Report');
const payload = {
  findings: synth.findings ?? [],
  criteria: synth.criteria ?? [],
  tier: plan.tier, gate: plan.gate,
  needsHuman: [...(synth.needsHuman ?? []), ...(resolved.needsHuman ?? [])],
  skipped: synth.skipped ?? [], strengths: synth.strengths ?? [], summary: synth.summary ?? '',
  context: { pr: bundle?.pr, tickets: bundle?.tickets, existingComments: bundle?.existingComments, trackerUsage: bundle?.trackerUsage },
  verify: resolved.summary ?? {},
  plan, agentRuns,
  commentMode: flags?.comment === true,
  startedAt: startedAt ?? null, prNumber: prNumber ?? null, worktrees: worktrees ?? [],
  learningStore: plan.learning?.store ?? null, range: plan.range ?? null,
};
const reportOut = await agent(
  `Run this EXACT command from the repo root and return ONLY the folder path it prints after the arrow:\n` +
  `cat <<'ACR_EOF' | node "${lib}/report.mjs"${flags?.gate ? ' --gate' : ''}\n${JSON.stringify(payload)}\nACR_EOF`,
  { agentType: 'general-purpose', label: 'report', phase: 'Report', schema: { type: 'object', properties: { folderPath: { type: 'string' }, verdict: { type: 'string' } }, required: ['folderPath'] } },
).catch((e) => { notes.push(`report failed: ${e.message}`); return { folderPath: null, verdict: 'ERROR' }; });

return { folderPath: reportOut.folderPath, gate: reportOut.verdict, needsHuman: payload.needsHuman, notes };
