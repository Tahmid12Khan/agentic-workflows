#!/usr/bin/env node
// Pure helpers + a thin CLI: the bounded adversarial-verification policy.
//
// Rule the user set: never re-run the whole review. Re-check ONLY the aspects a
// reviewer was not sure about, and look at any one aspect at most 3 times total
// (1 original review + at most 2 verifier passes). A verifier tries to REFUTE the
// finding; majority rules. Still uncertain after the cap → hand to the human,
// never silently drop.

export const DEFAULT_VERIFY = {
  maxPassesPerAspect: 3,      // total looks incl. the original review
  maxSubagentsPerAspect: 3,   // hard cap on agents touching one aspect
  reverifyBelow: 80,          // confidence under this → must be verified
  reportConfidence: 80,       // at/above this (post-verify) → into the report
  escalateUncertain: true,
  // Cheap→strong verifier escalation. The first refute runs on the cheap model; an uncertain or
  // hot-refuted verdict escalates to the strong model (whose verdict is then authoritative). The
  // highest cost-of-miss severities skip the cheap pass and go straight to the strong model.
  modelFirst: 'sonnet',
  modelEscalate: 'opus',
  escalateDirectSeverity: ['critical'],
};

const HOT_SEVERITIES = ['critical', 'important', 'high'];

export function verifyPolicy(config = {}) {
  const v = config.verify ?? {};
  const p = { ...DEFAULT_VERIFY, ...clean(v) };
  // verifier passes available after the 1 original review, also capped by agent budget
  p.maxVerifierPasses = Math.max(0, Math.min(p.maxPassesPerAspect - 1, p.maxSubagentsPerAspect));
  return p;
}

// Which findings need an adversarial second look?
// - confidence under reverifyBelow, OR
// - the reviewer explicitly flagged uncertainty, OR
// - a high-severity claim on a risk path (high cost-of-miss → confirm it).
export function selectForVerification(findings, policy = DEFAULT_VERIFY, opts = {}) {
  const riskPaths = new Set(opts.riskPaths ?? []);
  return (findings ?? []).filter((f) => {
    if (f.uncertain === true) return true;
    if (f.confidence == null) return true;             // unscored → always verify, never a free pass (distinct from an explicit 0)
    if (f.confidence < policy.reverifyBelow) return true;
    const hot = ['critical', 'important', 'high'].includes(f.severity);
    if (hot && isOnRiskPath(f, riskPaths)) return true;
    return false;
  });
}

// Which adversarial lens should verify a finding? Diversity matters: a security
// finding must be attacked as a trust-boundary/taint problem, a race as an
// interleaving/happens-before problem — not all as "re-read the guards". Same
// verifier-pass budget, a different angle of attack, so correlated blind spots
// don't survive exactly where cost-of-miss is highest.
export const VERIFY_LENS = {
  D3: { lens: 'security', agent: 'taint-verifier', focus: 'Follow the taint: trace the untrusted input to its sink and check the trust boundary, authz, and injection surface. A guard elsewhere only refutes the finding if it dominates EVERY path to the sink.' },
  D4: { lens: 'error-handling', focus: 'Trace the failure path: is the error swallowed, logged-and-continued, or surfaced so the caller can act? Check the catch scope and the rethrow/return contract.' },
  D6: { lens: 'data', focus: 'Check transaction scope, reversibility/rollback, and data-loss on the migration/query path; consider partial failure mid-operation.' },
  D7: { lens: 'concurrency', focus: 'Reason about interleavings and happens-before, not just the guards present. Construct a concrete racing schedule that breaks it, or show no such schedule exists; check idempotency/retry.' },
  D8: { lens: 'resources', focus: 'Trace the handle/connection lifecycle: is every acquired resource released on EVERY path including error/early-return? Check pool sizing, leaks, timeouts, and keep-alive.' },
  D9: { lens: 'performance', focus: 'Establish the realistic input scale and the complexity/allocation on the hot path; a micro-cost is not a finding, a super-linear blow-up is.' },
  D10: { lens: 'api-compat', focus: 'Compare old vs new contract: is this a breaking change for an existing consumer (removed/renamed field, narrowed type, changed status/route/event)? Check versioning.' },
  D11: { lens: 'type-design', focus: 'Can the changed type now represent an illegal state? Did the change widen a type, weaken an invariant, or add an unchecked any/cast?' },
  D14: { lens: 'observability', focus: 'Does the new failure mode emit a log/metric/trace a responder could act on, without leaking secrets/PII? Confirm the change adds, not removes, visibility.' },
};
export function lensFor(finding = {}) {
  return VERIFY_LENS[finding.dimension] ?? { lens: 'correctness', focus: 'Re-read the real code path, callers and guards around file:line and decide whether the claimed defect holds on the CHANGED lines.' };
}

// Decide a single finding's fate from the verifier verdicts collected for it.
// verdicts: [{ verdict: 'real'|'refuted'|'uncertain', confidence?, reason?, lens? }]
// Never consumes more than maxVerifierPasses verdicts (enforces the 3-look cap).
export function resolveVerification(finding, verdicts = [], policy = DEFAULT_VERIFY) {
  const used = verdicts.slice(0, policy.maxVerifierPasses);
  const real = used.filter((v) => v.verdict === 'real').length;
  const refuted = used.filter((v) => v.verdict === 'refuted').length;
  const passes = 1 + used.length; // original review + verifier passes

  // An unscored finding (confidence == null) is untrustworthy, not maximally
  // confident — treat it as low so the >=2-confirmations rule applies and it can't
  // ship unverified. Distinct from an explicit 0 only at SELECTION.
  const scored = finding.confidence != null;
  let decision, confidence = scored ? finding.confidence : 0;
  const wasLowConf = !scored || confidence < policy.reportConfidence;
  // High-stakes = the cases the selector force-verifies / cares most about missing.
  const hot = ['critical', 'important', 'high'].includes(finding.severity);
  // A 2nd refutation is only reachable when the budget affords >=2 verifier passes.
  // Under a starved budget (maxVerifierPasses < 2) a lone refuter IS the full pass,
  // so let it drop — otherwise a genuinely-false hot finding would be undroppable
  // and pile up in needs-human forever.
  const twoLooksAffordable = policy.maxVerifierPasses >= 2;
  if (used.length === 0) {
    decision = 'keep';
  } else if (refuted > real) {
    // Symmetric burden of proof: when a 2nd look was affordable, one refuter must not
    // drop a high-stakes finding — hand it to a human instead, never silently dropped.
    if (hot && refuted < 2 && twoLooksAffordable && policy.escalateUncertain) {
      decision = 'needs-human';
    } else {
      decision = 'drop';
    }
  } else if (real > refuted) {
    // A finding that entered BECAUSE it was low-confidence needs >=2 confirmations;
    // a single "real" vote must not bootstrap a weak finding past the floor.
    if (wasLowConf && real < 2) {
      decision = policy.escalateUncertain ? 'needs-human' : 'drop';
    } else {
      decision = 'keep';
      confidence = Math.max(confidence, 80);
    }
  } else {
    // tie / all-uncertain after the cap
    decision = policy.escalateUncertain ? 'needs-human' : 'drop';
  }
  return {
    ...finding,
    confidence,
    verify: { passes, real, refuted, decision, capped: verdicts.length > used.length, lenses: [...new Set(used.map((v) => v.lens).filter(Boolean))] },
    decision,
  };
}

// Split a resolved set into what ships, what was dropped, and what needs a human.
export function partition(resolved, policy = DEFAULT_VERIFY) {
  const report = [], dropped = [], needsHuman = [];
  for (const f of resolved) {
    if (f.decision === 'needs-human') needsHuman.push(f);
    else if (f.decision === 'drop') dropped.push(f);
    else if ((f.confidence ?? 0) >= policy.reportConfidence) report.push(f); // unscored never ships unverified
    else needsHuman.push({ ...f, decision: 'needs-human' }); // survived but still low-conf
  }
  return { report, dropped, needsHuman };
}

function isOnRiskPath(f, riskPaths) {
  if (riskPaths.size === 0) return false;
  const file = f.file ?? '';
  for (const r of riskPaths) if (file.toLowerCase().includes(r)) return true;
  return false;
}

// Which model runs the FIRST verifier pass for this finding. The highest cost-of-miss severities
// (default: critical) go straight to the strong model — no point spending a cheap pass we would
// escalate anyway; everything else gets the cheap model first.
export function firstPassModel(finding = {}, policy = DEFAULT_VERIFY) {
  const direct = new Set(policy.escalateDirectSeverity ?? DEFAULT_VERIFY.escalateDirectSeverity);
  return direct.has(finding.severity) ? policy.modelEscalate : policy.modelFirst;
}

// After a CHEAP first pass, does this verdict need the strong model? Escalate when the cheap verdict
// can't stand alone: it was uncertain, or it refuted a hot (critical/important/high) finding — never
// drop a hot finding on a single cheap refuter. A clean confirm/refute of a non-hot finding stands.
// On escalation the strong verdict is authoritative; the cheap one is discarded.
export function shouldEscalate(finding = {}, verdict, policy = DEFAULT_VERIFY) {
  const v = (verdict && typeof verdict === 'object') ? verdict.verdict : verdict;
  if (v === 'uncertain') return true;
  if (v === 'refuted' && HOT_SEVERITIES.includes(finding.severity)) return true;
  return false;
}

function clean(o) {
  const out = {};
  if (o.max_passes_per_aspect != null) out.maxPassesPerAspect = o.max_passes_per_aspect;
  if (o.max_subagents_per_aspect != null) out.maxSubagentsPerAspect = o.max_subagents_per_aspect;
  if (o.reverify_below != null) out.reverifyBelow = o.reverify_below;
  if (o.report_confidence != null) out.reportConfidence = o.report_confidence;
  if (o.escalate_uncertain != null) out.escalateUncertain = o.escalate_uncertain;
  if (o.model_first != null) out.modelFirst = o.model_first;
  if (o.model_escalate != null) out.modelEscalate = o.model_escalate;
  if (Array.isArray(o.escalate_direct_severity)) out.escalateDirectSeverity = o.escalate_direct_severity;
  return out;
}

// --- CLI: makes the bound an enforced, auditable code path, not just prose ---
// verify.mjs select   — stdin {findings, config, riskPaths} → which findings must be verified
// verify.mjs resolve  — stdin {findings:[{...finding, verdicts:[...]}], config, riskPaths}
//                       → {report, dropped, needsHuman, summary}
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const input = await new Promise((r) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => r(b)); });
  const data = JSON.parse(input || '{}');
  const policy = verifyPolicy(data.config ?? {});
  if (cmd === 'select') {
    // attach the adversarial lens per finding so the orchestrator dispatches a
    // dimension-appropriate verifier (security→taint, concurrency→interleaving, …)
    // instead of N identical refuters.
    const sel = selectForVerification(data.findings ?? [], policy, { riskPaths: data.riskPaths ?? [] })
      .map((f) => ({ ...f, ...lensFor(f) }));
    process.stdout.write(JSON.stringify({ select: sel, maxVerifierPasses: policy.maxVerifierPasses, maxSubagentsPerAspect: policy.maxSubagentsPerAspect }, null, 2) + '\n');
  } else if (cmd === 'resolve') {
    const resolved = (data.findings ?? []).map((f) => resolveVerification(f, f.verdicts ?? [], policy));
    const part = partition(resolved, policy);
    const summary = `verified ${resolved.filter((f) => f.verify?.passes > 1).length} finding(s): ${part.report.length} kept, ${part.dropped.length} refuted, ${part.needsHuman.length} need human (cap ${policy.maxPassesPerAspect} looks/aspect)`;
    process.stdout.write(JSON.stringify({ ...part, summary }, null, 2) + '\n');
  } else {
    console.error('usage: verify.mjs select|resolve  (JSON on stdin)');
    process.exit(2);
  }
}
