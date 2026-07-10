// Pure: signals + config → review plan. No I/O, no model calls.

function globMatch(glob, file) {
  const re = new RegExp(
    '^' + glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ' ')
      .replace(/\*/g, '[^/]*')
      .replace(/ /g, '.*') + '$'
  );
  return re.test(file);
}

const TIER_ORDER = ['trivial', 'low', 'standard', 'high', 'critical'];

const TIER_DIMENSIONS = {
  trivial:  ['D2', 'D13'],
  low:      ['D1', 'D2', 'D5'],
  standard: ['D1', 'D2', 'D4', 'D5', 'D12'],
  high:     ['D1','D2','D4','D5','D10','D11','D12','D16'],
  critical: ['D1','D2','D3','D4','D5','D6','D7','D8','D12','D14'],
};

// Dimensions whose cost-of-miss justifies opus — but only from OPUS_MIN_TIER up, where
// the extra reasoning earns its cost; on a standard/low change they run on the tier's
// base model (spend follows risk, worst-case tiers keep opus). Keys are D-numbers,
// checked against DIMENSION_LABELS: D3 security & vulns, D7 concurrency & async,
// D9 scalability & perf.
const OPUS_DIMS = new Set(['D3', 'D7', 'D9']);

// Lever D (fan-out trim): net-new content-gated specialists trimmed to cut agent count when
// config.fanout.trim is on. DEFER_DIMS are advisory specialists deferred to DEFER_BELOW+ (perf/a11y
// on a sub-high change is usually caught by the correctness screen; they return at high/critical).
// GATED_KEEP_ORDER ranks content-gated dims most-worth-keeping → least when config.fanout.max_added
// caps the count: security/data (D6/D7) > correctness (D4/D11) > contract/deps/advisory. Base-tier
// dims and explicit always_dims are never trimmed.
const DEFER_DIMS = new Set(['D9', 'D17']);
const DEFER_BELOW = 'high';
const GATED_KEEP_ORDER = ['D6', 'D7', 'D4', 'D11', 'D10', 'D15', 'D9', 'D17'];
const OPUS_MIN_TIER = 'high';

// dimension → the bundled agent that covers it. correctness-reviewer covers the
// always-on trio (D1/D2/D12); everything else has a dedicated specialist so the
// plugin is fully self-contained.
export const DIMENSION_AGENTS = {
  D1: 'correctness-reviewer', D2: 'correctness-reviewer', D12: 'correctness-reviewer',
  D3: 'vuln-reviewer',
  D4: 'error-handling-reviewer',
  D5: 'test-adequacy-reviewer',
  D6: 'data-store-reviewer', D8: 'data-store-reviewer',
  D7: 'concurrency-reviewer',
  D9: 'perf-scalability-reviewer',
  D10: 'api-compat-reviewer',
  D11: 'type-design-reviewer',
  D13: 'docs-comment-reviewer',
  D14: 'observability-reviewer',
  D15: 'dependency-reviewer',
  D16: 'simplification-reviewer',
  D17: 'a11y-i18n-reviewer',
};

export const DIMENSION_LABELS = {
  D1: 'intent & traceability', D2: 'correctness & quality', D3: 'security & vulns',
  D4: 'error handling', D5: 'test adequacy', D6: 'data & DB', D7: 'concurrency & async',
  D8: 'connections & resources', D9: 'scalability & perf', D10: 'API contract & compat',
  D11: 'type design', D12: 'project-rules compliance', D13: 'docs & comment accuracy',
  D14: 'observability', D15: 'dependency & supply chain', D16: 'simplification', D17: 'a11y & i18n',
};

// Per-dimension model = f(dimension, tier): opus on the hardest dimensions (OPUS_DIMS)
// but only at OPUS_MIN_TIER and above, the tier's base model otherwise — so a standard/low
// change gets no opus reviewer unless a floor raised its tier. Migration escalation and
// (via the already-raised tier) risk_map floors apply as POST-matrix overrides, never as a
// matrix cell. Exported so a --dimensions override can recompute models for its new dimension
// set, not leave stale ones. Config overrides: models.by_tier (base model per tier),
// models.opus_dims (which dims escalate), models.opus_min_tier (the floor tier).
export function pickModels(dims, tier, signals = {}, config = {}) {
  const list = Array.isArray(dims) ? dims : [...dims];
  const m = config.models ?? {};
  const opusDims = new Set(m.opus_dims ?? OPUS_DIMS);
  const minTier = TIER_ORDER.includes(m.opus_min_tier) ? m.opus_min_tier : OPUS_MIN_TIER;
  const opusEligible = TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(minTier);
  const models = {};
  for (const d of list) models[d] = (opusEligible && opusDims.has(d)) ? 'opus' : tierModel(tier, m.by_tier);
  // Post-matrix override: an irreversible data migration always gets opus on D6, at any tier —
  // the one place a cheaper model is not worth the data-loss risk.
  if (signals.riskPaths?.includes('migration') && list.includes('D6')) models.D6 = 'opus';
  return models;
}

// Clamp a tier DOWN to a ceiling (--max-tier). Only lowers — a computed tier at or below the
// ceiling passes through untouched. An unknown/absent ceiling is a no-op. Never raises.
export function capTier(tier, maxTier) {
  const mi = TIER_ORDER.indexOf(maxTier);
  if (mi < 0) return tier;
  const ti = TIER_ORDER.indexOf(tier);
  return ti > mi ? maxTier : tier;
}

export function planReview(signals, config, forceTier, maxTier, fanIn) {
  // forceTier (--tier) is AUTHORITATIVE: an explicit tier PINS the review depth exactly — neither
  // risk_map (raise) nor maxTier (cap) touches it. When the user says "standard", they get standard.
  // Only the AUTO path (no --tier) lets risk_map escalate the computed base tier for a configured
  // critical path, and then --max-tier clamps that result down to a ceiling (the pr-review-loop's
  // budget cap: compute honestly, then cap). The whole plan (dimensions, models, runVerify) is
  // recomputed from the resulting tier, so an override is a real depth change, not just a relabel. An
  // unknown/typo tier ('crit', 'auto', …) is ignored rather than producing an empty no-op plan.
  const notes = [];
  const ft = TIER_ORDER.includes(forceTier) ? forceTier : undefined;
  const tier = ft ?? capTier(applyFanInEscalation(applyRiskMap(baseTier(signals), signals, config), fanIn, config, notes), maxTier);

  const dims = new Set(TIER_DIMENSIONS[tier]);

  // content-gated additions — collected SEPARATELY from the tier's base set so lever D
  // (fan-out trim) can defer/cap the net-new specialists without touching base coverage.
  const gated = new Set();
  if (signals.depsChanged) gated.add('D15');
  if (signals.publicContract) gated.add('D10');
  if (signals.riskPaths.includes('migration')) gated.add('D6');
  if (signals.concurrencyTouched) gated.add('D7');
  if (signals.errorHandlingTouched) gated.add('D4');
  if (signals.typesTouched) gated.add('D11');
  if (signals.perfSensitive) gated.add('D9');
  if (signals.uiTouched) gated.add('D17');
  if (signals.languages.includes('java') || signals.languages.includes('sql')) gated.add('D6');
  // a dim already in the base tier is not a NET addition — don't let lever D count or trim it.
  for (const d of dims) gated.delete(d);

  // Lever D (fan-out trim, config.fanout.trim): OFF by default → both steps below are no-ops and
  // every gated dim is added, exactly as before. When on, trim the content-gated fan-out WIDTH
  // (agent count) — the third cost axis after model price (verify sonnet-first) and tokens/agent
  // (per-file diff slices). Base-tier dims and explicit always_dims are never trimmed. The CRITICAL
  // tier is exempt entirely — it is the exhaustive tier where full specialist coverage beats cost.
  const fan = config.fanout ?? {};
  const trimmed = [];
  if (fan.trim && tier !== 'critical') {
    const keepOrder = fan.keep_order ?? GATED_KEEP_ORDER;
    const rank = (d) => { const i = keepOrder.indexOf(d); return i < 0 ? Number.MAX_SAFE_INTEGER : i; };
    // 1. defer advisory specialists (perf D9 / a11y D17) below the floor tier — their signal on a
    //    sub-high change is usually covered by the correctness screen; they return at high/critical.
    const deferDims = new Set(fan.defer_dims ?? DEFER_DIMS);
    const deferBelow = TIER_ORDER.includes(fan.defer_below) ? fan.defer_below : DEFER_BELOW;
    if (TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(deferBelow)) {
      for (const d of deferDims) if (gated.delete(d)) trimmed.push(d);
    }
    // 2. cap the content-gated specialist COUNT: keep the highest-priority max_added, drop the rest.
    //    Deterministic — rank by keep_order, tie-break by dim id (no Date/random).
    const cap = fan.max_added;
    if (Number.isInteger(cap) && gated.size > cap) {
      const keep = new Set([...gated].sort((a, b) => (rank(a) - rank(b)) || (a < b ? -1 : a > b ? 1 : 0)).slice(0, cap));
      for (const d of [...gated]) if (!keep.has(d)) { gated.delete(d); trimmed.push(d); }
    }
  }
  for (const d of gated) dims.add(d);

  // Project opt-in: dimensions the config always wants regardless of tier — e.g. D16
  // simplification, a taste pass trimmed to opt-in below the high tier. Unknown ids ignored.
  // Explicit opt-ins are NEVER subject to lever D — they are added after the trim.
  for (const d of config.always_dims ?? []) if (DIMENSION_AGENTS[d]) dims.add(d);

  const models = pickModels([...dims], tier, signals, config);

  const agents = [...new Set([...dims].map((d) => DIMENSION_AGENTS[d]).filter(Boolean))];

  return {
    tier,
    dimensions: [...dims],
    models,
    agents,
    runVerify: tier !== 'trivial',
    mandatoryChecks: config.mandatory_checks ?? [],
    gate: config.gate ?? { block_on: ['critical'], warn_on: ['important'] },
    // Lever D: net-new specialists dropped from the fan-out (deferred or capped). [] when trim off.
    // Surfaced in the report's "Did not run" so the reduced coverage is explicit, never silent.
    trimmed: trimmed.sort(),
    // Human-readable explanations for auto-tier decisions beyond risk_map (e.g. fan-in escalation).
    // [] when nothing fired — always present so callers don't need an `?? []` guard.
    notes,
  };
}

// Blast-radius escalation: a one-line change to a widely-imported module (e.g. a global config
// default flip) can slip through on lexical signals alone — no risk path, no public-contract marker,
// no concurrency token — because those signals never look at WHO imports the changed file. fanIn
// (computed cheaply in plan.mjs via `git grep`, see signals.mjs's moduleSpecifiers) is the number of
// distinct in-repo files outside the diff that import the changed file with the highest count, plus
// which file that was. Bumps exactly ONE tier level (low→standard, standard→high) and never reaches
// critical — that tier stays reserved for the existing hot-path signals (risk paths, public contract,
// concurrency), which are stronger evidence than import count alone. Config key fanin_threshold
// (default 20); 0 disables. Runs only on the AUTO path — like applyRiskMap, it is inside the `ft ?? …`
// expression in planReview, so an explicit --tier bypasses it entirely.
function applyFanInEscalation(tier, fanIn, config, notes) {
  const threshold = config.fanin_threshold ?? 20;
  if (!fanIn || threshold <= 0 || fanIn.count < threshold) return tier;
  const bumped = tier === 'low' ? 'standard' : tier === 'standard' ? 'high' : tier;
  if (bumped !== tier) notes.push(`fan-in escalation: ${fanIn.file} imported by ${fanIn.count} files`);
  return bumped;
}

// Tier C ("exhaustive") gate — the ultrareview-parity passes that cost extra tokens. On with
// --exhaustive (opts.flag) or automatically at the critical tier (config.exhaustive.on_critical,
// default true). Pure so it is unit-testable. The passes that ACTUALLY exist: the completeness critic
// (false-negative guard after synthesis), the D3 taint verifier, and (S7.1) a DOUBLE RUN of the
// correctness + vuln reviewers — two independent passes unioned + deduped by findingKey before Verify,
// for real decorrelation. The former generativeVerify / loopUntilDry / maxRounds fields were RETIRED
// (S7.2): they had zero consumers (the verify prompt is refute-only, the fan-out runs once), so
// documenting them as live was dishonest. Do not re-add a flag here without a real consumer in
// review-workflow.mjs.
export function exhaustivePlan(tier, config = {}, opts = {}) {
  const exh = config.exhaustive ?? {};
  const on = opts.flag === true || (tier === 'critical' && (exh.on_critical ?? true));
  // S6.1: a CHEAP completeness SCREEN (haiku, no diff) runs on EVERY workflow tier (low/standard/high)
  // — one x1 haiku coverage-gap pass per review — but only when the full exhaustive critic is NOT
  // already running (exhaustive supersedes it, never both) and only where the Workflow runs (trivial
  // is reviewed inline, so no screen there). Opt-out via config.completeness.screen_on_high:false
  // (kept as the toggle name for back-compat; now governs the screen on all tiers). Scoped to
  // dimension/criterion coverage gaps.
  const screenEnabled = config.completeness?.screen_on_high ?? true;
  const screenTiers = new Set(['low', 'standard', 'high']);
  return {
    exhaustive: on,
    completenessCritic: on, // false-negative guard after synthesis (review.md step 8b)
    completenessScreen: !on && screenTiers.has(tier) && screenEnabled, // S6.1 cheap haiku screen on every workflow tier
    // Gap re-dispatch budget for the screen: spend follows blast radius — low trusts the screen and
    // re-dispatches nothing (haiku coverage note only), standard ≤1, high ≤2. The full exhaustive
    // critic uses its own ≤6 (hardcoded at its call site).
    screenGapCap: tier === 'high' ? 2 : tier === 'standard' ? 1 : 0,
    taint: on,              // route D3 verify to the taint-verifier (review.md step 7)
    doubleRun: on,          // S7.1: run correctness + vuln reviewers twice, union+dedupe by findingKey
  };
}

function baseTier(s) {
  if (s.docOnly) return 'trivial';
  const hot = s.riskPaths.length > 0 || s.publicContract || s.concurrencyTouched;
  if (hot) return 'critical';
  if (s.fileCount <= 3 && s.netLoc <= 40 && s.testsPresent) return 'low';
  return 'standard';
}

function tierModel(tier, byTier) {
  return byTier?.[tier] ?? (tier === 'trivial' ? 'haiku' : 'sonnet');
}

function applyRiskMap(tier, signals, config) {
  const map = config.risk_map ?? {};
  for (const forced of ['critical', 'high']) {
    const globs = map[forced] ?? [];
    if (globs.some(g => signals.__files?.some?.(f => globMatch(g, f)))) {
      return higher(tier, forced);
    }
  }
  return tier;
}

function higher(a, b) {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

// --- Effort (WS4): USER INTENT for THIS RUN — noise tolerance + verification depth — completely
// orthogonal to tier (RISK of the change, computed above). applyEffort adjusts report/verify
// THRESHOLDS AND CAPS ONLY: it never touches plan.tier, and it never touches plan.gate (the render-
// layer confidence GATE is a fixed floor — see render.mjs's MIN_CONFIDENCE — and effort never
// loosens it; only the REPORT display bar moves, high/max can only lower that). 'medium' is an
// identity pass-through: today's behavior, byte for byte. plan.mjs calls this once verifyPolicy()
// has resolved the tier's real verify budget, so "cap -1 per tier" and "cap at the high-tier value"
// operate on the ACTUAL resolved number, not a re-derivation of the tier.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'];

// Mirrors verify.mjs's MAX_VERIFIER_AGENTS_BY_TIER.high (8) — high/max effort's "broaden coverage"
// promise means at least high-tier verification thoroughness regardless of the change's actual risk
// tier. Duplicated rather than imported (triage.mjs stays a pure, dependency-free module; verify.mjs
// is the source of truth) — keep this in sync if that table's 'high' entry ever changes.
const HIGH_TIER_VERIFIER_AGENTS = 8;

export function applyEffort(plan, effort) {
  const level = EFFORT_LEVELS.includes(effort) ? effort : 'medium';
  const verify = { ...(plan.verify ?? {}) };
  const out = { ...plan, effort: level, verify };
  if (level === 'medium') return out; // identity — nothing below this line runs

  if (level === 'low') {
    // Fewer, higher-confidence findings: raise the report bar and trim one verifier seat off
    // whatever the tier already budgeted (floor 1 — never fully disable verification).
    verify.reportConfidence = 90;
    verify.maxVerifierAgents = Math.max(1, (verify.maxVerifierAgents ?? 5) - 1);
  } else {
    // high or max: broaden coverage. Lower the report bar so sub-gate findings surface (the render
    // layer segregates them into an "Uncertain (verify manually)" section — they never reach the
    // fixed gate floor) and guarantee at least high-tier verifier thoroughness even on a low-risk
    // change. max additionally implies --exhaustive and disables fan-out trim — both are plan.mjs
    // concerns (they act BEFORE dims/discovery are computed), not thresholds/caps, so they live there.
    verify.reportConfidence = 60;
    verify.maxVerifierAgents = Math.max(verify.maxVerifierAgents ?? 0, HIGH_TIER_VERIFIER_AGENTS);
  }
  return out;
}
