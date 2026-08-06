import { DIMENSION_AGENTS, DIMENSION_LABELS } from './triage.mjs';

const SEV_ORDER = ['critical', 'important', 'minor', 'suggestion'];
const MIN_CONFIDENCE = 80;

// --- agent coverage: who ran, who didn't, and why ---
// Pure: derive the agent run-down from the deterministic plan (plan.mjs output)
// plus an optional `runs` map (agentName → actual dispatch count the orchestrator
// observed, which captures shard fan-out, spawn-on-doubt, and verifier passes).
// Encodes the dispatch rules from commands/review.md so the report can state what
// happened without trusting the model's memory.
// Findings and coverage carry BOTH the internal Dn code and its human name. `dimName` = the
// dimension's readable label (config override → built-in table → raw value); `dimAgentName` = the
// reviewer that owns it (D6 → data-store-reviewer); `codeAgent` = "D6 data-store-reviewer", the
// finding-tag form. Unmapped values (e.g. scrutiny labels) pass through unchanged.
const dimName = (d, labels = {}) => labels[d] ?? DIMENSION_LABELS[d] ?? d;
const dimAgentName = (d) => DIMENSION_AGENTS[d] ?? d;
const codeAgent = (d) => `${d} ${dimAgentName(d)}`;
const dimLabel = (d, labels) => `${d} ${dimName(d, labels)}`.trim();

function reviewerRows(plan) {
  const planned = new Set(plan.dimensions ?? []);
  const trimmed = new Set(plan.trimmed ?? []);
  const labels = plan.dimensionLabels ?? {};
  const models = plan.models ?? {};
  const shards = plan.sharded ? (plan.shardCount ?? plan.shards?.length ?? 1) : 1;
  const byAgent = new Map();
  for (const [dim, agent] of Object.entries(DIMENSION_AGENTS)) {
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(dim);
  }
  const rows = [];
  for (const [name, allDims] of byAgent) {
    const dims = allDims.filter(d => planned.has(d));
    const ran = dims.length > 0;
    // Lever D (fan-out trim): a reviewer that did NOT run because its dimension was DROPPED to cut
    // agent count is distinct from one whose dimension simply never signalled — say so explicitly so
    // the reduced coverage is never silent.
    const trimmedHere = ran ? [] : allDims.filter(d => trimmed.has(d));
    rows.push({
      name,
      kind: 'reviewer',
      ran,
      model: ran ? (models[dims[0]] ?? '—') : '—',
      covers: (ran ? dims : allDims).map(d => dimLabel(d, labels)).join(', '),
      plannedRuns: ran ? dims.length * shards : 0,
      reason: ran
        ? `reviewed ${dims.map(d => dimLabel(d, labels)).join(', ')}${shards > 1 ? ` across ${shards} shards` : ''}`
        : trimmedHere.length
          ? `${trimmedHere.map(d => dimLabel(d, labels)).join(', ')} signalled but was dropped by fan-out trim (config.fanout.trim) to cut agent count`
          : `no ${allDims.map(d => dimLabel(d, labels)).join(' / ')} dimension was triggered for this change`,
    });
  }
  return rows;
}

function pipelineRows(plan) {
  const tier = plan.tier ?? 'standard';
  const trivial = tier === 'trivial';
  const d = plan.discovery ?? {};
  // Batched verification is sonnet-FIRST: the refuter groups run on modelFirst (sonnet), and only a
  // group holding a critical finding — plus the +1 reverify guard — runs on verifyModel (opus). So the
  // finding-verifier row shows the sonnet→opus split, not a single model.
  const vmodel = plan.verify?.verifyModel ?? 'opus';
  const fmodel = plan.verify?.modelFirst ?? 'sonnet';
  const budget = plan.verify?.maxVerifierAgents ?? 5;
  // completeness runs as EITHER the opus exhaustive critic (Tier C: critical/--exhaustive) OR the
  // cheap x1 sonnet screen (every workflow tier: low/standard/high) — never both. Reflect whichever.
  const critic = !!d.completenessCritic;
  const screen = !critic && !!d.completenessScreen;
  const mk = (name, model, role, ran, reason) => ({ name, kind: 'pipeline', model, covers: role, ran, plannedRuns: ran ? 1 : 0, reason });
  return [
    mk('triage-classifier', 'sonnet', 'tier sanity-check', !trivial, trivial ? 'skipped — trivial change reviewed inline' : 'confirmed/raised the tier and added missed dimensions'),
    mk('intent-analyzer', 'sonnet', 'intent + criteria + grouping + domain logic + open questions', !trivial, trivial ? 'skipped — a trivial change is reviewed inline' : 'built the acceptance-criteria model, grouped primary vs extra intents, and surfaced domain-logic open questions'),
    mk('finding-verifier', `${fmodel}→${vmodel}`, 'batched adversarial refute of unsure findings + reverify guard', !!plan.runVerify, plan.runVerify ? `unsure findings grouped by (lens, file) into ≤${budget} ${fmodel} verifier(s) (opus for a critical group), then a +1 opus reverify guard hunts false negatives` : `skipped — verification runs at low+ (tier: ${tier})`),
    mk('taint-verifier', vmodel, 'data-flow security verify (D3)', !!d.taint, d.taint ? 'exhaustive taint pass on security findings' : 'skipped — exhaustive (Tier C) only'),
    mk('completeness-critic', critic ? 'opus' : 'sonnet', 'false-negative guard', critic || screen,
      critic ? 'exhaustive completeness sweep (opus, with the diff)' : screen ? 'x1 sonnet coverage-gap screen (no diff)' : 'skipped — trivial change reviewed inline'),
    mk('review-synthesizer', 'sonnet', 'dedupe, traceability, verdict', !trivial, trivial ? 'skipped — trivial change reviewed inline' : 'deduped findings and built this report'),
  ];
}

export function agentCoverage(plan = {}, runs = {}) {
  const tier = plan.tier ?? 'standard';
  // Whether the orchestrator handed us real dispatch counts. When it did (any non-empty
  // map), those counts are authoritative and COMPLETE — every dispatched agent is counted —
  // so an agent the plan expected but that has no entry dispatched 0 times. RAN must then
  // follow the observed count, never the planned `r.ran` flag: otherwise a planned-but-never
  // -dispatched agent shows up under "ran … 0×" (or a phantom "ran 1×" via the planned
  // fallback). Only when NO counts were observed (the trivial inline path passes `{}`) do we
  // fall back to the plan's expectation.
  const observed = !!runs && Object.keys(runs).length > 0;
  const rows = [...pipelineRows(plan), ...reviewerRows(plan)].map(r => {
    const count = observed ? (runs[r.name] ?? 0) : r.plannedRuns;
    const didRun = observed ? count > 0 : r.ran;
    const reason = (observed && r.ran && count === 0)
      ? 'planned for this change but no dispatch was recorded (spawn failed or gated out at runtime)'
      : r.reason;
    return { ...r, runs: count, ran: didRun, reason };
  });
  const ran = rows.filter(r => r.ran);
  const notRun = rows.filter(r => !r.ran);
  const dispatches = ran.reduce((n, r) => n + (r.runs || 0), 0);
  return {
    tier,
    trivialInline: tier === 'trivial',
    ran,
    notRun,
    total: rows.length,
    ranCount: ran.length,
    dispatches,
  };
}

// Verdict from the gate-affecting (in-diff, conf≥80) findings. `tier` enables the sanity
// floor (S1.2 of plan.md): a high/critical-risk change with ZERO surviving findings is far
// more likely an under-review than a clean bill, so it never silently APPROVEs — it emits a
// non-blocking WARN (exit 0) with `floor: true` so the report can explain why. Callers pass
// only the IN-DIFF findings here; demoted out-of-diff findings never reach the verdict.
export function renderVerdict(findings, gate, tier = null) {
  const present = new Set(findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE).map(f => f.severity));
  const blocks = (gate.block_on ?? ['critical']).some(s => present.has(s));
  const warns = (gate.warn_on ?? ['important']).some(s => present.has(s));
  if (blocks) return { verdict: 'BLOCK', exitCode: 1 };
  if (warns) return { verdict: 'WARN', exitCode: 0 };
  if ((tier === 'high' || tier === 'critical') && present.size === 0) return { verdict: 'WARN', exitCode: 0, floor: true };
  return { verdict: 'APPROVE', exitCode: 0 };
}

// WS6: split the out-of-diff (advisory-only) findings into PRE-EXISTING BUGS — a real defect at
// bug severity (critical/important), verified real (or trusted at high confidence) but NOT introduced
// by this change — vs OBSERVATIONS (everything else anchored outside the change). Pre-existing bugs
// are the valuable signal Anthropic's 🟣 tier carries; they stay advisory (never affect verdict/gate/
// comments) but deserve their own section instead of being buried in undifferentiated observations.
// A finding is "verified real" when a verifier re-checked it and upheld it (real >= refuted), or when
// it was trusted (not re-checked — it already survived synthesis at confidence >= 80).
const verifiedReal = (f) => {
  const v = f?.verify;
  if (!v || !(v.passes > 1)) return true;              // trusted, high-confidence — treat as real
  return (v.real ?? 0) >= (v.refuted ?? 0);            // re-checked and upheld
};
export function partitionOutOfDiff(outOfDiff = []) {
  const preExisting = [], observations = [];
  for (const f of outOfDiff) {
    const bugSeverity = f.severity === 'critical' || f.severity === 'important';
    // A "🟣 Pre-existing bug" is a CONFIRMED defect — require conf>=80 like the in-diff gate, so a
    // sub-80 out-of-diff finding surfaced at --effort high/max is treated as an observation, not
    // over-stated as a confirmed bug in the tally / severityTally.preExisting (WS4×WS6 consistency).
    const highConf = (f.confidence ?? 100) >= MIN_CONFIDENCE;
    (bugSeverity && highConf && verifiedReal(f)) ? preExisting.push(f) : observations.push(f);
  }
  return { preExisting, observations };
}

// WS9: a one-line tally right under the title ("2 important, 3 minor, 1 pre-existing — WARN") so a
// reader can triage the whole review without scrolling (Anthropic's "summary shape" guidance).
export function tallyLine(kept, preExistingCount, verdict) {
  const bits = SEV_ORDER.map((s) => [s, kept.filter((f) => f.severity === s).length])
    .filter(([, n]) => n).map(([s, n]) => `${n} ${s}`);
  if (preExistingCount) bits.push(`${preExistingCount} pre-existing`);
  return `${bits.length ? bits.join(', ') : 'no findings'} — ${verdict}`;
}

// Files-capped WARN (shared by the markdown + HTML reports): the diff exceeded max_review_files, so the
// lowest-risk files were dropped from review to keep the Workflow args payload emittable. State it
// plainly — this review may MISS issues in the unreviewed files. null when nothing was capped.
export function filesCappedWarning(filesCapped) {
  if (!filesCapped || !filesCapped.dropped) return null;
  const { reviewed, total, dropped, max } = filesCapped;
  return `> ⚠️ **WARN — file limit exceeded (max ${max}).** This change touches **${total}** files; only the **${reviewed}** highest-risk were reviewed and **${dropped}** were not. Issues in the unreviewed files may be missed. Raise \`large_diff.max_review_files\`, split the PR, or review the rest separately.`;
}

// --- Effort (WS4): the run's user-intent knob (report/verify thresholds+caps) — orthogonal to tier
// (risk). Neither helper below touches the GATE: renderVerdict's confidence floor is fixed
// (MIN_CONFIDENCE) and takes no effort/threshold argument at all, so the gate cannot loosen no
// matter what a caller passes here.

// Split OUT the confidence band [reportThreshold, MIN_CONFIDENCE) — findings verify kept as real
// but below the fixed gate floor, that THIS run's effort chose to surface anyway (high/max lower
// reportThreshold below MIN_CONFIDENCE). Empty at medium (reportThreshold defaults to MIN_CONFIDENCE)
// and at low (reportThreshold 90 sits ABOVE MIN_CONFIDENCE — clamped down, so the band is empty:
// low never surfaces uncertain findings). Exported so effort.test.mjs can assert the split directly.
export function splitUncertain(findings = [], reportThreshold = null) {
  const floor = reportThreshold != null ? Math.min(reportThreshold, MIN_CONFIDENCE) : MIN_CONFIDENCE;
  return (findings ?? []).filter((f) => {
    const c = f.confidence ?? 100;
    return c >= floor && c < MIN_CONFIDENCE;
  });
}

// One header line naming the effort level + what it concretely changed on THIS run (same
// transparency style as the other cost levers — fan-out trim, sharding, …). null at 'medium' (an
// identity pass-through — nothing to announce) and when no effort was recorded at all (older
// payloads). reportThreshold is the RESOLVED plan.verify.reportConfidence, so the wording reflects
// what actually happened, not just the level's name.
export function effortLine(effort, reportThreshold) {
  if (!effort || effort === 'medium') return null;
  if (reportThreshold != null && reportThreshold < MIN_CONFIDENCE) {
    return `Effort: ${effort} — report bar lowered to ≥${reportThreshold}; sub-${MIN_CONFIDENCE} findings surface under "Uncertain (verify manually)" instead of being held back`;
  }
  if (reportThreshold != null && reportThreshold > MIN_CONFIDENCE) {
    return `Effort: ${effort} — report bar raised to ≥${reportThreshold}; anything the verifier couldn't confirm is dropped, not surfaced`;
  }
  return `Effort: ${effort}`;
}

// WS3: one header line naming the re-review round, once it's worth mentioning (round 1 — the
// common case, a first review — says nothing, same identity-pass-through style as effortLine).
// nitRounds names the config the reader would tune (rereview.nit_rounds) if the report-only
// cutoff feels wrong for this project.
export function convergenceLine(round, nitRounds) {
  if (!round || round <= 1) return null;
  return `Re-review round ${round} — minor/suggestion findings are report-only from round ${(nitRounds ?? 1) + 1} on (config rereview.nit_rounds: ${nitRounds ?? 1})`;
}

// WS3: a fresh finding the convergence round or the nit cap held back from posting as a comment
// (see rereview.nitConvergence / comments.capNits) — informational tag only, never affects
// whether the finding is LISTED in the report (it always is).
function notPostableTag(f) {
  if (f.notPostable === 'convergence') return 'report-only · convergence';
  if (f.notPostable === 'nit-cap') return 'report-only · nit-cap';
  return null;
}

// A finding's location, with the optional endLine folded in as a range (D-agnostic — every
// dimension agent can set endLine on a multi-line fixCode). No line -> just the file.
const loc = (f) => `${f.file}${f.line ? ':' + f.line + (f.endLine && f.endLine > f.line ? '-' + f.endLine : '') : ''}`;

// An open-question / needs-human item may arrive as a plain string or as an object
// with any of several text fields — never render an empty card.
function humanText(f) {
  if (typeof f === 'string') return f || '(unspecified)';
  if (f && typeof f === 'object') return f.question || f.title || f.text || f.summary || '(unspecified — see context)';
  return '(unspecified)';
}

function metaBits(meta) {
  if (!meta) return [];
  const b = [];
  if (meta.prNumber) b.push(`PR #${meta.prNumber}`);
  if (meta.started) b.push(`started ${meta.started}`);
  if (meta.finished) b.push(`${meta.started ? 'finished' : 'generated'} ${meta.finished}`);
  if (meta.duration) b.push(`took ${meta.duration}`);
  return b;
}

// One header line for the executed-test signal (S6.4, --run-tests). Names only, never logs.
// Returns null when tests were not run (the common case — the flag is off by default).
export function testSignalText(ts, maxNames = 8) {
  if (!ts || !ts.ran) return null;
  if (ts.passed) return 'Tests: passed';
  const all = (ts.failing ?? []).filter(Boolean);
  const shown = all.slice(0, maxNames);
  const more = all.length > shown.length ? `, +${all.length - shown.length} more` : '';
  return `Tests: FAILED${shown.length ? ` — ${shown.join(', ')}${more}` : ''}`;
}

// WS7 S3: one line naming the shared context pack's size + per-section counts (context-pack.mjs's
// stderr line, surfaced in the report) — so the cost impact of the optional sections (imports,
// callers, hop-2, type-boundary) is visible to a reader, not just in a log nobody sees. Returns
// null when no pack was built (--stats-out absent/failed, or the pre-step was skipped).
export function contextPackStatsLine(stats) {
  if (!stats) return null;
  return `Context pack: ${stats.sizeBytes}B across ${stats.files} file(s) — imports ${stats.imports}, callers ${stats.callerHits}, hop-2 ${stats.hop2}, type-boundary ${stats.typeBoundary}`;
}

// State, per enabled tracker, whether it was actually used (via MCP) this run.
// Off trackers are omitted; enabled ones always appear so the report is explicit.
const TRACKER_NAMES = { clickup: 'ClickUp', jira: 'Jira' };
const TRACKER_STATUS = {
  used: 'used',
  'skipped-no-mcp': 'skipped — MCP server not connected',
  'no-keys': 'enabled — no ticket keys in PR/commits',
  off: 'off',
};
function trackerLines(usage = {}) {
  const out = [];
  for (const k of ['clickup', 'jira']) {
    const u = usage?.[k];
    if (!u || u.status === 'off') continue;
    const label = TRACKER_STATUS[u.status] ?? u.status;
    out.push(`${TRACKER_NAMES[k] ?? k}: ${label}${u.detail ? ` (${u.detail})` : ''}`);
  }
  return out;
}

// One line naming exactly what was checked out for the review: the head ref HEAD was
// detached onto, the base it was diffed against, and the head sha — so the report records
// the precise code reviewed. Returns [] when the review ran in place (no checkout).
function checkoutLine(checkout) {
  if (!checkout || !checkout.headRef) return [];
  const base = checkout.baseRef ? ` vs ${checkout.baseRef}` : '';
  const at = checkout.sha ? ` @ ${String(checkout.sha).slice(0, 8)}` : '';
  return [`${checkout.headRef}${base}${at}`];
}

// base/target commit facts for the markdown header (the HTML report gets a dedicated PR-info
// panel instead). Per side: branch, short sha, date, subject, plus origin sha when the reviewed
// ref diverged from <remote>/<branch>. Returns [] when the review ran in place (no checkout).
function commitFacts(checkout) {
  if (!checkout) return [];
  const out = [];
  const side = (label, c) => {
    if (!c) return;
    const sha = c.sha ? ` \`${String(c.sha).slice(0, 8)}\`` : '';
    const date = c.date ? ` (${c.date})` : '';
    const subj = c.subject ? ` — ${c.subject}` : '';
    const origin = (c.origin && c.origin.sha) ? ` · origin \`${String(c.origin.sha).slice(0, 8)}\`${c.origin.date ? ` (${c.origin.date})` : ''}` : '';
    out.push(`**${label}** \`${c.branch || c.ref || '?'}\`${sha}${date}${subj}${origin}`);
  };
  side('base', checkout.baseCommit);
  side('target', checkout.headCommit);
  return out;
}

export function renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, summaryPoints, context, verify, learnings, coverage, meta, checkout = null, usage = null, outOfDiff = [], testSignal = null, processAdvisories = [], gate = { block_on: ['critical'], warn_on: ['important'] }, effort = null, reportThreshold = null, round = null, nitRounds = null, contextPackStats = null, filesCapped = null }) {
  const kept = (findings ?? []).filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const uncertain = splitUncertain(findings, reportThreshold);   // WS4: high/max's sub-gate, surfaced band
  const vd = renderVerdict(findings ?? [], gate, tier);   // WS6: honor the configured gate.block_on (not hardcoded critical-only); computed early so the WS9 tally line can quote it too
  const lines = [`# Code Review — ${tier}`, '', `**${tallyLine(kept, partitionOutOfDiff(outOfDiff).preExisting.length, vd.verdict)}**`, ''];
  // Files-capped WARN: the change exceeded max_review_files, so some files were NOT reviewed. Loud and
  // near the top — findings on the dropped files are absent, not clean. Advisory only (never gates).
  const fcw = filesCappedWarning(filesCapped);
  if (fcw) lines.push(fcw, '');
  const mb = metaBits(meta);
  if (mb.length) lines.push(`_${mb.join(' · ')}_`, '');
  const ef = effortLine(effort, reportThreshold);
  if (ef) lines.push(`_${ef}_`, '');
  const cl = convergenceLine(round, nitRounds);   // WS3: which re-review round this is
  if (cl) lines.push(`_${cl}_`, '');
  const cf = commitFacts(checkout);
  if (cf.length) { for (const l of cf) lines.push(`- ${l}`); lines.push(''); }
  const tsText = testSignalText(testSignal);
  if (tsText) lines.push(`_${tsText}_`, '');

  if (summary) lines.push(summary, '');
  // Headline above; scannable bullets below. The synthesizer emits both — a 1-line verdict and the
  // 3-6 points behind it — so the report leads with a scannable list instead of one wall paragraph.
  if (summaryPoints?.length) {
    for (const p of summaryPoints) lines.push(`- ${p}`);
    lines.push('');
  }
  if (strengths?.length) {
    lines.push('## Strengths', '');
    for (const s of strengths) lines.push(`- ${s}`);
    lines.push('');
  }

  lines.push('## Requirement traceability', '');
  if (!(criteria ?? []).length) lines.push('_No acceptance criteria were captured for this change._', '');
  for (const c of criteria ?? []) {
    const name = c.name || c.text || c.id;          // lead with the requirement, not the bare id
    const tag = (c.name || c.text) ? ` \`${c.id}\`` : '';
    const status = c.covered ? (c.evidence ? `covered — _${c.evidence}_` : 'covered') : '**not covered**';
    lines.push(`- [${c.covered ? 'x' : ' '}] **${name}**${tag} — ${status}`);
  }
  lines.push('');

  for (const sev of SEV_ORDER) {
    const group = kept.filter(f => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${cap(sev)}`, '');
    for (const f of group) {
      // "verified" only when a verifier actually looked (passes > 1). passes === 1 / no verify block =
      // trusted on reviewer confidence (≥80, off risk paths) per the selectForVerification cost policy —
      // label it so an absent "verified" tag is never ambiguous (it isn't a missing check, it's a skipped one).
      const vtag = (f.verify && f.verify.passes > 1) ? `verified ×${f.verify.passes}` : 'trusted';
      const tags = [f.dimension, f.isNew ? 'new' : null, f.recurring ? 'recurring' : null, f.persisting ? 'persisting' : null, notPostableTag(f), vtag].filter(Boolean).join(' · ');
      lines.push(`- **${f.title}** (${tags}) — \`${loc(f)}\` _(conf ${f.confidence})_`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    }
    lines.push('');
  }

  // WS3: findings also present in the LAST review of this PR — never re-posted as a comment
  // (comments.mjs skips them), so the report calls them out separately instead of leaving the
  // reader to infer "still open" from the absence of a "new" tag above.
  const stillOpen = kept.filter(f => f.persisting);
  if (stillOpen.length) {
    lines.push(`## Still open (${stillOpen.length})`, '',
      '_Present in this review and the last — not re-posted as a new comment._', '');
    for (const f of stillOpen) lines.push(`- **${f.title}** — \`${loc(f)}\``);
    lines.push('');
  }
  // WS3: fresh findings the convergence round / nit cap held back from posting — informational
  // only, they're already listed above like any other finding.
  const heldBack = kept.filter(f => f.notPostable);
  if (heldBack.length) {
    const convergenceCount = heldBack.filter(f => f.notPostable === 'convergence').length;
    const capCount = heldBack.filter(f => f.notPostable === 'nit-cap').length;
    const bits = [
      convergenceCount ? `${convergenceCount} report-only (round > rereview.nit_rounds)` : null,
      capCount ? `plus ${capCount} similar nit(s) not posted (report.max_posted_nits)` : null,
    ].filter(Boolean).join(', ');
    lines.push(`_${bits}._`, '');
  }

  // WS4 (high/max effort): findings verify kept as real but below the fixed gate floor, surfaced
  // here instead of the severity sections above — never gate-affecting (renderVerdict never sees
  // this band; it only ever reads confidence >= MIN_CONFIDENCE).
  if (uncertain.length) {
    lines.push(`## Uncertain (verify manually) (${uncertain.length})`, '',
      `_Below the report floor (${MIN_CONFIDENCE}) but surfaced at this run's effort level — never affects the verdict._`, '');
    for (const f of uncertain) {
      const tags = [f.dimension && codeAgent(f.dimension), f.severity].filter(Boolean).join(' · ');
      lines.push(`- **${f.title}**${tags ? ` (${tags})` : ''} — \`${loc(f)}\` _(conf ${f.confidence})_`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    }
    lines.push('');
  }

  if (outOfDiff?.length) {
    // These went through the SAME verification pass as in-diff findings (verify runs before the
    // scope split) — so show each one's verified/trusted tag rather than falsely blanket-labeling
    // the section "unverified". They stay advisory for the gate/`--comment` only because they anchor
    // outside the changed lines. WS6: bug-severity, verified items surface as PRE-EXISTING BUGS
    // (Anthropic's 🟣 tier) in their own section; the rest are undifferentiated observations.
    const { preExisting, observations } = partitionOutOfDiff(outOfDiff);
    const oosLine = (f) => {
      const vtag = (f.verify && f.verify.passes > 1) ? `verified ×${f.verify.passes}` : 'trusted';
      const tags = [f.dimension && codeAgent(f.dimension), f.severity, vtag].filter(Boolean).join(' · ');
      lines.push(`- **${f.title}**${tags ? ` (${tags})` : ''} — \`${loc(f)}\``);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    };
    if (preExisting.length) {
      lines.push(`## Pre-existing bugs (${preExisting.length}) 🟣`, '',
        '_Real defects NOT introduced by this change — advisory only (excluded from the verdict and `--comment`). Worth a separate fix._', '');
      for (const f of preExisting) oosLine(f);
      lines.push('');
    }
    if (observations.length) {
      lines.push(`## Out-of-scope observations (${observations.length})`, '',
        '_Anchored outside the changed lines — verified like any finding, but advisory only (excluded from the verdict and `--comment`)._', '');
      for (const f of observations) oosLine(f);
      lines.push('');
    }
  }

  // WS1 process advisories: deterministic change-shape advice (change sizing). ADVISORY only —
  // never affects the verdict, gate, or --comment. Rendered in its own section so it can't be
  // mistaken for a defect finding.
  if (processAdvisories?.length) {
    lines.push(`## Process advisories (${processAdvisories.length})`, '',
      '_Change-shape advice (size / splitting) — advisory only, never gate-affecting._', '');
    for (const a of processAdvisories) lines.push(`- ${a.message ?? a}`);
    lines.push('');
  }

  if (needsHuman?.length) {
    lines.push(`## Needs your input (${needsHuman.length})`, '', 'Re-checked to the cap and still split — your call.', '');
    for (const f of needsHuman) {
      const q = humanText(f);
      const locStr = (f && typeof f === 'object' && f.file) ? ` — \`${loc(f)}\`` : '';
      lines.push(`- **${q}**${locStr}`);
      if (f && typeof f === 'object') {
        if (f.evidence) lines.push(`  - ${f.evidence}`);
        if (f.verify) lines.push(`  - ${f.verify.passes}× looks · ${f.verify.real} real / ${f.verify.refuted} refuted`);
      }
    }
    lines.push('');
  }

  if (coverage) {
    lines.push('## Agents & coverage', '');
    lines.push(`${coverage.ranCount} of ${coverage.total} bundled agents ran, ${coverage.dispatches} dispatch(es) total (tier: ${coverage.tier}).`, '');
    if (coverage.trivialInline) lines.push('_Trivial change — reviewed in a single inline pass; no reviewer subagents were dispatched._', '');
    const cpsLine = contextPackStatsLine(contextPackStats);
    if (cpsLine) lines.push(`_${cpsLine}._`, '');
    lines.push('### Ran', '');
    if (!coverage.ran.length) lines.push('- _none_');
    for (const a of coverage.ran) {
      lines.push(`- **${a.name}** (${a.model}, ${a.runs}×) — ${a.reason}`);
    }
    lines.push('', '### Did not run', '');
    if (!coverage.notRun.length) lines.push('- _none — every bundled agent ran_');
    for (const a of coverage.notRun) {
      lines.push(`- **${a.name}** — ${a.reason}`);
    }
    lines.push('');
  }

  if (usage) {
    lines.push('## Cost', '');
    const hit = usage.cacheHitPct != null ? `, cache hit ${fmtPct(usage.cacheHitPct)}` : '';
    lines.push(`${fmtUsd(usage.costUsd)} · ${fmtInt(usage.inputTokens)} in / ${fmtInt(usage.outputTokens)} out / ${fmtInt(usage.cacheReadTokens)} cache-read${hit}`, '');
    for (const b of usage.breakdown ?? []) {
      lines.push(`- **${b.scope} · ${b.model}** — ${fmtUsd(b.costUsd)}${b.cacheHitPct != null ? ` (cache hit ${fmtPct(b.cacheHitPct)})` : ''}`);
    }
    if ((usage.breakdown ?? []).length) lines.push('');
  }

  if (skipped?.length) {
    lines.push('## Notes', '');
    for (const s of skipped) lines.push(`- ${s.dimension ? `**${s.dimension}** — ` : ''}${s.reason ?? s}`);
    lines.push('');
  }

  const trackers = trackerLines(context?.trackerUsage);
  const wlines = checkoutLine(checkout);
  if ((context && (context.pr || context.tickets?.length || context.existingComments?.length)) || trackers.length || wlines.length) {
    lines.push('## Context used', '');
    if (context?.pr) lines.push(`- PR: ${context.pr.title ?? '(untitled)'}`);
    for (const t of context?.tickets ?? []) lines.push(`- ${t.tracker ?? 'issue'} ${t.key}: ${t.title ?? ''}`);
    if (context?.existingComments?.length) lines.push(`- ${context.existingComments.length} existing PR comment(s) folded in`);
    for (const l of trackers) lines.push(`- Tracker ${l}`);
    for (const l of wlines) lines.push(`- Reviewed ${l}`);
    lines.push('');
  }

  const footer = [verify?.summary, learnings?.applied ? `memory: ${learnings.applied}` : null].filter(Boolean).join(' · ');
  if (footer) lines.push(`> ${footer}`, '');

  if (vd.floor) lines.push('_No findings survived on a high-risk change — WARN, not a clean pass. Verify manually._', '');
  lines.push(`## Verdict: ${vd.verdict}`);
  return lines.join('\n');
}

// --- full self-contained HTML report ---
export function renderHtml(data) {
  const { findings = [], criteria = [], tier = 'standard', needsHuman = [], skipped = [], strengths = [], summary = '', summaryPoints = [], context = {}, verify = {}, coverage = null, meta = null, checkout = null, usage = null, outOfDiff = [], testSignal = null, processAdvisories = [], gate = { block_on: ['critical'], warn_on: ['important'] }, effort = null, reportThreshold = null, round = null, nitRounds = null, contextPackStats = null, filesCapped = null } = data;
  const metaStr = metaBits(meta).join(' · ');
  const tsText = testSignalText(testSignal);
  const efLine = effortLine(effort, reportThreshold);
  const convLine = convergenceLine(round, nitRounds);   // WS3
  const kept = findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const uncertain = splitUncertain(findings, reportThreshold);   // WS4: high/max's sub-gate, surfaced band
  const { verdict, floor } = renderVerdict(findings, gate, tier);
  const tColor = { trivial: '#4FB8A8', low: '#8FBF5A', standard: '#F0A92B', high: '#E8742E', critical: '#E23E4E' }[tier] || '#F0A92B';
  const vColor = { APPROVE: '#8FBF5A', WARN: '#F0A92B', BLOCK: '#E23E4E' }[verdict];
  const counts = SEV_ORDER.map(s => [s, kept.filter(f => f.severity === s).length]).filter(([, n]) => n);
  // WS9: same tally as the md report's headline — add a pre-existing pill so the top-of-report
  // counts row (badge + pills) carries the identical signal without a separate text line.
  const preExistingCount = partitionOutOfDiff(outOfDiff).preExisting.length;
  if (preExistingCount) counts.push(['pre-existing', preExistingCount]);

  // Token usage + USD cost of this review run — the left column of the info row below the
  // header meta line. The four token counts sit in a 2-wide grid (input | cache read on top,
  // output | cache write below), with cost spanning under them. Omitted entirely when no usage
  // was captured (usage.mjs returns null) so the report is unchanged for runs without transcripts.
  const usageRow = (k, v) => `<div class="u-row"><span class="u-k">${k}</span><span class="u-v">${esc(v)}</span></div>`;
  // Per-(scope, model) cost split — orchestrator vs the reviewer fan-out, by model
  // family — so the report shows what actually dominates spend. Omitted when the
  // tally carries no breakdown (older callers / no transcripts).
  const usageBreakdown = (usage?.breakdown ?? [])
    .map(b => usageRow(`${b.scope} · ${b.model}`, fmtUsd(b.costUsd))).join('');
  const usagePanel = usage ? `<aside class="usage" title="this review run">
    <div class="u-grid">
      ${usageRow('input', fmtInt(usage.inputTokens))}
      ${usageRow('cache read', fmtInt(usage.cacheReadTokens))}
      ${usageRow('output', fmtInt(usage.outputTokens))}
      ${usageRow('cache write', fmtInt(usage.cacheWriteTokens))}
    </div>
    ${usage.cacheHitPct != null ? usageRow('cache hit', fmtPct(usage.cacheHitPct)) : ''}
    ${usageBreakdown}
    <div class="u-row u-cost"><span class="u-k">cost</span><span class="u-v">${esc(fmtUsd(usage.costUsd))}</span></div>
  </aside>` : '';

  // PR info — the right column of the info row: which commits were reviewed on each side.
  // Per side: branch, short sha, commit date, subject; plus an origin line only when the
  // reviewed ref diverged from <remote>/<branch> (checkout.mjs drops it otherwise). Omitted
  // when the review ran in place (no checkout → no commit facts).
  const shortSha = (s) => esc(String(s || '').slice(0, 8));
  const prSide = (label, c) => {
    if (!c) return '';
    const originLine = (c.origin && c.origin.sha)
      ? `<div class="pr-origin">origin ${shortSha(c.origin.sha)}${c.origin.date ? ` · ${esc(c.origin.date)}` : ''}${c.origin.subject ? ` · ${esc(c.origin.subject)}` : ''}</div>`
      : '';
    return `<div class="pr-side">
      <div class="pr-top"><span class="pr-lbl">${label}</span><span class="pr-branch">${esc(c.branch || c.ref || '')}</span></div>
      <div class="pr-commit"><span class="pr-sha">${shortSha(c.sha)}</span>${c.date ? `<span class="pr-date">${esc(c.date)}</span>` : ''}</div>
      ${c.subject ? `<div class="pr-msg">${esc(c.subject)}</div>` : ''}
      ${originLine}
    </div>`;
  };
  const prInfo = (checkout && (checkout.baseCommit || checkout.headCommit))
    ? `<div class="prinfo">${prSide('base', checkout.baseCommit)}${prSide('target', checkout.headCommit)}</div>`
    : '';

  // One row, two columns: usage/cost left-aligned, PR info right-aligned. Empty spacers keep a
  // lone column pinned to its side (usage stays left, PR info stays right). Whole row omitted
  // when neither is present.
  const infoRow = (usagePanel || prInfo)
    ? `<div class="info-row">${usagePanel || '<span></span>'}${prInfo || '<span></span>'}</div>`
    : '';

  const sevBlock = SEV_ORDER.map(sev => {
    const g = kept.filter(f => f.severity === sev);
    if (!g.length) return '';
    return `<section class="grp"><h3 class="sev sev-${sev}">${cap(sev)} <span class="n">${g.length}</span></h3>` +
      g.map(f => `<article class="finding">
        <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-loc">${esc(f.file)}:${f.line ?? '?'}${f.endLine && f.line && f.endLine > f.line ? '-' + f.endLine : ''}</span></div>
        <div class="f-meta">${f.dimension ? `<span class="f-dim" title="${esc(dimName(f.dimension))}">${esc(codeAgent(f.dimension))}</span>` : ''}${f.isNew ? ' · <b class="new">new</b>' : ''}${f.recurring ? ' · <b class="rec">recurring</b>' : ''}${f.persisting ? ' · <b class="rec">persisting</b>' : ''}${notPostableTag(f) ? ` · <b class="rec">${esc(notPostableTag(f))}</b>` : ''}${(f.verify && f.verify.passes > 1) ? ` · <b class="ver">verified ×${f.verify.passes}</b> (${f.verify.real}✓/${f.verify.refuted}✗)` : ' · trusted'} · conf ${f.confidence ?? '—'}</div>
        ${f.evidence ? `<p class="f-ev"><b>evidence</b> ${esc(f.evidence)}</p>` : ''}
        ${f.fix ? `<p class="f-fix"><b>fix</b> ${esc(f.fix)}</p>` : ''}
      </article>`).join('') + `</section>`;
  }).join('');

  // WS3: findings also present in the LAST review of this PR — never re-posted (comments.mjs
  // skips them), called out separately so the reader doesn't have to infer "still open" from the
  // absence of a "new" tag above.
  const stillOpenFindings = kept.filter(f => f.persisting);
  const stillOpenBlock = stillOpenFindings.length ? `<section class="grp"><p class="hint">Present in this review and the last — not re-posted as a new comment.</p>` +
    stillOpenFindings.map(f => `<article class="finding"><div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-loc">${esc(f.file)}:${f.line ?? '?'}${f.endLine && f.line && f.endLine > f.line ? '-' + f.endLine : ''}</span></div></article>`).join('') + `</section>` : '';
  // WS3: fresh findings the convergence round / nit cap held back from posting — informational,
  // they're already listed in the Findings section above regardless.
  const heldBackFindings = kept.filter(f => f.notPostable);
  const heldBackNote = heldBackFindings.length ? (() => {
    const convergenceCount = heldBackFindings.filter(f => f.notPostable === 'convergence').length;
    const capCount = heldBackFindings.filter(f => f.notPostable === 'nit-cap').length;
    const bits = [
      convergenceCount ? `${convergenceCount} report-only (round > rereview.nit_rounds)` : null,
      capCount ? `plus ${capCount} similar nit(s) not posted (report.max_posted_nits)` : null,
    ].filter(Boolean).join(', ');
    return `<p class="hint">${esc(bits)}.</p>`;
  })() : '';

  const human = needsHuman.length ? `<section class="grp needshuman"><h3>⚠ Needs your input <span class="n">${needsHuman.length}</span></h3>
    <p class="hint">Re-checked to the cap and still split — your call.</p>` +
    needsHuman.map(f => {
      const o = (f && typeof f === 'object') ? f : {};
      const locSpan = o.file ? `<span class="f-loc">${esc(loc(o))}</span>` : '';
      return `<article class="finding"><div class="f-head"><span class="f-title">${esc(humanText(f))}</span>${locSpan}</div>${o.evidence ? `<p class="f-ev">${esc(o.evidence)}</p>` : ''}${o.verify ? `<div class="f-meta">${o.verify.passes}× looks — ${o.verify.real} real / ${o.verify.refuted} refuted</div>` : ''}</article>`;
    }).join('') + `</section>` : '';

  const skip = skipped.length ? `<section class="grp">` +
    skipped.map(s => `<div class="skipline">${s.dimension ? `<b>${esc(s.dimension)}</b> — ` : ''}${esc(s.reason ?? String(s))}</div>`).join('') + `</section>` : '';

  // Out-of-diff findings: advisory-only, anchored outside the changed lines — rendered dimmed
  // and excluded from the verdict/gate/comments (S1.1 of plan.md). WS6: bug-severity, verified
  // items are split out as PRE-EXISTING BUGS (Anthropic's 🟣 tier) in their own block.
  const { preExisting: preExistingOOS, observations: observationsOOS } = partitionOutOfDiff(outOfDiff);
  const oosArticle = (f) => `<article class="finding oos">
      <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-loc">${esc(loc(f))}</span></div>
      <div class="f-meta">${esc(f.dimension || '')}${f.severity ? ` · ${esc(f.severity)}` : ''}</div>
      ${f.evidence ? `<p class="f-ev"><b>evidence</b> ${esc(f.evidence)}</p>` : ''}
      ${f.fix ? `<p class="f-fix"><b>fix</b> ${esc(f.fix)}</p>` : ''}
    </article>`;
  const preExistingBlock = preExistingOOS.length ? `<section class="grp"><p class="hint">Real defects NOT introduced by this change — advisory only, excluded from the verdict and <code>--comment</code>. Worth a separate fix.</p>` +
    preExistingOOS.map(oosArticle).join('') + `</section>` : '';

  // WS4 (high/max effort): sub-gate-floor findings surfaced instead of held back — never gate-affecting.
  const uncertainBlock = uncertain.length ? `<section class="grp"><p class="hint">Below the report floor (≥${MIN_CONFIDENCE}) but surfaced at this run's effort level — never affects the verdict.</p>` +
    uncertain.map(f => `<article class="finding">
      <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-loc">${esc(f.file)}:${f.line ?? '?'}${f.endLine && f.line && f.endLine > f.line ? '-' + f.endLine : ''}</span></div>
      <div class="f-meta">${esc(f.dimension || '')}${f.severity ? ` · ${esc(f.severity)}` : ''} · conf ${f.confidence ?? '—'}</div>
      ${f.evidence ? `<p class="f-ev"><b>evidence</b> ${esc(f.evidence)}</p>` : ''}
      ${f.fix ? `<p class="f-fix"><b>fix</b> ${esc(f.fix)}</p>` : ''}
    </article>`).join('') + `</section>` : '';
  const outDiffBlock = observationsOOS.length ? `<section class="grp"><p class="hint">Anchored outside the changed lines — advisory only, excluded from the verdict and <code>--comment</code>.</p>` +
    observationsOOS.map(oosArticle).join('') + `</section>` : '';

  // WS1 process advisories (change-shape advice) — advisory only, dimmed like out-of-scope.
  const procBlock = processAdvisories.length ? `<section class="grp"><p class="hint">Change-shape advice (size / splitting) — advisory only, never gate-affecting.</p>` +
    processAdvisories.map(a => `<div class="skipline">${esc(a.message ?? a)}</div>`).join('') + `</section>` : '';

  const crit = (criteria || []).map(c => {
    const name = c.name || c.text || c.id;
    const tag = (c.name || c.text) ? ` <code>${esc(c.id)}</code>` : '';
    return `<li class="${c.covered ? 'ok' : 'no'}"><span class="box">${c.covered ? '✓' : '○'}</span><b>${esc(name)}</b>${tag}${c.evidence ? `<em>${esc(c.evidence)}</em>` : `<em>${c.covered ? '' : 'not covered'}</em>`}</li>`;
  }).join('');

  const covSection = coverage ? (() => {
    const row = a => `<div class="cov-row"><span class="cov-name">${esc(a.name)}</span><span class="cov-meta">${a.ran ? `${esc(a.model)} · ${a.runs}×` : 'not run'}</span><span class="cov-why">${esc(a.reason)}</span></div>`;
    const inline = coverage.trivialInline ? `<p class="hint">Trivial change — reviewed in a single inline pass; no reviewer subagents were dispatched.</p>` : '';
    const cpsLine = contextPackStatsLine(contextPackStats);
    const cps = cpsLine ? `<p class="hint">${esc(cpsLine)}.</p>` : '';
    return `<section class="cov">
      <p class="cov-sum">${coverage.ranCount} of ${coverage.total} bundled agents ran · ${coverage.dispatches} dispatch(es) · tier ${esc(coverage.tier)}</p>${inline}${cps}
      <div class="cov-grp"><h4 class="cov-h ran">Ran (${coverage.ran.length})</h4>${coverage.ran.map(row).join('') || '<div class="cov-row"><span class="cov-why">none</span></div>'}</div>
      <div class="cov-grp"><h4 class="cov-h off">Did not run (${coverage.notRun.length})</h4>${coverage.notRun.map(row).join('') || '<div class="cov-row"><span class="cov-why">none — every bundled agent ran</span></div>'}</div>
    </section>`;
  })() : '';

  const ctxItems = [];
  if (context.pr) ctxItems.push(`PR: ${esc(context.pr.title || 'untitled')}`);
  (context.tickets || []).forEach(t => ctxItems.push(`${esc(t.tracker || 'issue')} ${esc(t.key)}: ${esc(t.title || '')}`));
  if (context.existingComments?.length) ctxItems.push(`${context.existingComments.length} existing PR comment(s) folded in`);
  trackerLines(context.trackerUsage).forEach(l => ctxItems.push(`Tracker ${esc(l)}`));
  checkoutLine(checkout).forEach(l => ctxItems.push(`Reviewed ${esc(l)}`));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Review — ${esc(tier)} · ${verdict}</title>
<style>
:root{--bg:#0C1618;--panel:#11201E;--line:#1F3A35;--text:#DCE6E1;--muted:#7E938C;--accent:#F0A92B;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;--sans:-apple-system,system-ui,"Segoe UI",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;font-size:17px}
.wrap{max-width:960px;margin:0 auto;padding:44px 24px 90px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:8px}
.info-row{display:flex;justify-content:space-between;align-items:stretch;gap:24px;flex-wrap:nowrap;margin:16px 0 28px}
.usage{flex:0 0 auto;display:flex;flex-direction:column;justify-content:space-between;padding:11px 15px;border:1px solid var(--line);border-radius:9px;background:var(--panel);font-family:var(--mono);font-size:12.5px}
.usage .u-grid{display:grid;grid-template-columns:auto auto;column-gap:28px;row-gap:2px}
.usage .u-row{display:flex;justify-content:space-between;gap:16px;padding:2px 0}
.usage .u-k{color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
.usage .u-v{color:var(--text)}
.usage .u-cost{margin-top:6px;padding-top:6px;border-top:1px solid var(--line)}
.usage .u-cost .u-v{color:var(--accent);font-weight:700}
.prinfo{flex:1 1 auto;min-width:0;font-family:var(--mono);font-size:12.5px;text-align:left;display:flex;flex-direction:column;gap:12px;padding:11px 15px;border:1px solid var(--line);border-radius:9px;background:var(--panel)}
.prinfo .pr-side{display:flex;flex-direction:column;gap:2px}
.prinfo .pr-top{display:flex;justify-content:flex-start;gap:9px;align-items:baseline}
.prinfo .pr-lbl{color:var(--muted);text-transform:uppercase;letter-spacing:.07em;font-size:11px}
.prinfo .pr-branch{color:var(--accent);font-weight:700}
.prinfo .pr-commit{display:flex;justify-content:flex-start;gap:11px}
.prinfo .pr-sha{color:var(--text)}
.prinfo .pr-date{color:var(--muted)}
.prinfo .pr-msg{color:var(--muted);overflow-wrap:anywhere}
.prinfo .pr-origin{color:var(--muted);opacity:.75;font-size:11.5px;margin-top:2px}
@media(max-width:600px){.info-row{gap:14px;flex-wrap:wrap}.usage,.prinfo{flex:1 1 100%}}
.badge{font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.06em;padding:7px 13px;border-radius:7px;color:#0c1618}
h1{font-size:30px;font-weight:800;letter-spacing:-.02em;margin:0;flex:1 1 auto}
.meta{font-family:var(--mono);font-size:13.5px;color:var(--muted);margin:14px 0 0}
.ts-pass{color:#8FBF5A}.ts-fail{color:#E23E4E}
.sub{font-size:16.5px;color:var(--text);margin:14px 0 10px}
.sum{margin:0 0 26px;padding-left:22px}.sum li{margin:6px 0;font-size:16px;color:var(--text)}
.legend{font-family:var(--mono);font-size:12.5px;color:var(--muted);margin:-4px 0 16px}.legend .ver{color:#8FBF5A}
.f-meta .ver{color:#8FBF5A}
.counts{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 30px}
.pill{font-family:var(--mono);font-size:13px;border:1px solid var(--line);border-radius:6px;padding:5px 10px;color:var(--muted)}
h2{font-size:15px;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:36px 0 14px}
.trace{list-style:none;padding:0;margin:0}.trace li{display:flex;gap:10px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line);font-size:16px}
.trace .box{font-family:var(--mono)}.trace .ok .box,.trace li.ok{color:var(--text)}.trace li.no{color:var(--muted)}.trace li.no .box{color:#E8742E}
.trace b{font-weight:700;font-size:16px}.trace code{font-family:var(--mono);font-size:13px;color:var(--muted)}.trace em{color:var(--muted);font-style:normal;margin-left:auto;font-family:var(--mono);font-size:13px}
.grp{margin:0 0 24px}.grp h3{font-size:18px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.grp .n{font-family:var(--mono);font-size:14px;color:var(--muted);font-weight:400}
.sev-critical{color:#E23E4E}.sev-important{color:#F0A92B}.sev-minor{color:#8FBF5A}.sev-suggestion{color:#4FB8A8}
.finding{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:9px;background:var(--panel);padding:15px 18px;margin-bottom:11px}
.f-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.f-title{font-weight:700;font-size:17px}.f-loc{font-family:var(--mono);font-size:14px;color:var(--muted)}
.f-meta{font-family:var(--mono);font-size:13px;color:var(--muted);margin:7px 0}.rec{color:var(--accent)}.f-meta .new{color:#4FB8A8}.f-dim{cursor:help;border-bottom:1px dotted var(--muted)}
.f-ev,.f-fix{font-size:15.5px;margin:7px 0 0;color:var(--muted)}.f-ev b,.f-fix b{font-family:var(--mono);font-size:12px;color:var(--text);margin-right:6px;text-transform:uppercase;letter-spacing:.06em}
.needshuman{border:1px solid #5a3a1e;border-radius:11px;padding:18px;background:rgba(240,169,43,.05)}.needshuman h3{color:var(--accent)}.hint{color:var(--muted);font-size:15px;margin:0 0 14px}
.skipline{font-family:var(--mono);font-size:14px;color:var(--muted);padding:6px 0}
.cov-sum{font-family:var(--mono);font-size:14px;color:var(--text);margin:0 0 14px}
.cov-grp{margin:0 0 18px}.cov-h{font-family:var(--mono);font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 7px}
.cov-h.ran{color:#8FBF5A}.cov-h.off{color:var(--muted)}
.cov-row{display:grid;grid-template-columns:220px 120px 1fr;gap:12px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line);font-size:15px}
.cov-name{font-family:var(--mono);font-size:14px;color:var(--text);word-break:break-all}.cov-meta{font-family:var(--mono);font-size:13px;color:var(--accent)}.cov-why{color:var(--muted)}
@media(max-width:600px){.cov-row{grid-template-columns:1fr;gap:2px}.cov-meta{color:var(--muted)}}
.ctx{font-family:var(--mono);font-size:14px;color:var(--muted)}.ctx div{padding:4px 0}
.foot{margin-top:42px;border-top:1px solid var(--line);padding-top:16px;font-family:var(--mono);font-size:13px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="top">
  <span class="badge" style="background:${tColor}">${esc(tier).toUpperCase()}</span>
  <h1>Code Review</h1>
  <span class="badge" style="background:${vColor}">${verdict}</span>
</div>
${filesCapped && filesCapped.dropped ? `<div class="cap-warn" style="background:${vColor === '#E23E4E' ? '#E23E4E' : '#F0A92B'};color:#111;padding:10px 14px;border-radius:8px;margin:10px 0;font-weight:600">⚠️ File limit exceeded (max ${filesCapped.max}): ${filesCapped.total} files changed, only the ${filesCapped.reviewed} highest-risk reviewed — ${filesCapped.dropped} not reviewed. Issues in the unreviewed files may be missed.</div>` : ''}
${metaStr ? `<div class="meta">${esc(metaStr)}</div>` : ''}
${efLine ? `<div class="meta">${esc(efLine)}</div>` : ''}
${convLine ? `<div class="meta">${esc(convLine)}</div>` : ''}
${tsText ? `<div class="meta ${testSignal && testSignal.passed ? 'ts-pass' : 'ts-fail'}">${esc(tsText)}</div>` : ''}
${infoRow}
<div class="sub">${esc(summary || '')}</div>
${summaryPoints.length ? `<ul class="sum">${summaryPoints.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
<div class="counts">${counts.map(([s, n]) => `<span class="pill">${n} ${s}</span>`).join('') || '<span class="pill">no blocking findings</span>'}</div>
${strengths.length ? `<h2>Strengths</h2><ul class="trace">${strengths.map(s => `<li class="ok"><span class="box">+</span>${esc(s)}</li>`).join('')}</ul>` : ''}
<h2>Requirement traceability</h2><ul class="trace">${crit || '<li class="no"><span class="box">○</span>no acceptance criteria captured</li>'}</ul>
<h2>Findings</h2>${sevBlock ? `<p class="legend"><b class="ver">verified ×N</b> = adversarially re-checked · <b>trusted</b> = high-confidence (≥${MIN_CONFIDENCE}), not re-checked (cost policy)</p>${sevBlock}` : `<p class="ctx">No findings at or above the confidence floor.${floor ? ' <b>High-risk change with zero findings — WARN, not a clean pass; verify manually.</b>' : ''}</p>`}
${stillOpenBlock ? `<h2>Still open (${stillOpenFindings.length})</h2>${stillOpenBlock}${heldBackNote}` : (heldBackNote ? `<h2>Notes</h2>${heldBackNote}` : '')}
${uncertainBlock ? `<h2>Uncertain (verify manually)</h2>${uncertainBlock}` : ''}
${preExistingBlock ? `<h2>Pre-existing bugs 🟣</h2>${preExistingBlock}` : ''}
${outDiffBlock ? `<h2>Out-of-scope observations</h2>${outDiffBlock}` : ''}
${procBlock ? `<h2>Process advisories</h2>${procBlock}` : ''}
${human ? `<h2>Open questions</h2>${human}` : ''}
${covSection ? `<h2>Agents &amp; coverage</h2>${covSection}` : ''}
${skip ? `<h2>Notes</h2>${skip}` : ''}
${ctxItems.length ? `<h2>Context used</h2><div class="ctx">${ctxItems.map(c => `<div>› ${c}</div>`).join('')}</div>` : ''}
<div class="foot">adversarial-code-review · advisory — never edits the code under review; fixes applied only via opt-in \`/review-respond --fix\` · ${verify.summary ? esc(verify.summary) : 'bounded adversarial verification'}</div>
</div></body></html>`;
}

const cap = s => s[0].toUpperCase() + s.slice(1);
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
// Tiny review costs need cents-level precision; large ones don't. Below $1 → 4 dp.
const fmtUsd = (n) => { const v = Number(n) || 0; return `$${v.toFixed(v < 1 ? 4 : 2)}`; };
const fmtPct = (f) => `${Math.round((Number(f) || 0) * 100)}%`;
