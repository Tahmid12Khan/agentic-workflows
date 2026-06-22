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
  low:      ['D1', 'D2', 'D5', 'D16'],
  standard: ['D1', 'D2', 'D4', 'D5', 'D12', 'D16'],
  high:     ['D1','D2','D4','D5','D10','D11','D12','D16'],
  critical: ['D1','D2','D3','D4','D5','D6','D7','D8','D12','D14'],
};

const OPUS_DIMS = new Set(['D3', 'D7', 'D9']);

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

// Per-dimension model choice: opus on the hardest dimensions, the tier model
// otherwise, opus for an irreversible migration. Exported so a --dimensions
// override can recompute models for its new dimension set, not leave stale ones.
export function pickModels(dims, tier, signals = {}) {
  const list = Array.isArray(dims) ? dims : [...dims];
  const models = {};
  for (const d of list) models[d] = OPUS_DIMS.has(d) ? 'opus' : tierModel(tier);
  if (signals.riskPaths?.includes('migration') && list.includes('D6')) models.D6 = 'opus';
  return models;
}

export function planReview(signals, config, forceTier) {
  // forceTier (--tier) sets the floor, then risk_map can still raise it — it never
  // lets a configured critical path be reviewed below its floor. The whole plan
  // (dimensions, models, runVerify) is recomputed from the resulting tier, so an
  // override is a real depth change, not just a relabel. An unknown/typo tier
  // ('crit', 'auto', …) is ignored rather than producing an empty no-op plan.
  const ft = TIER_ORDER.includes(forceTier) ? forceTier : undefined;
  let tier = ft ?? baseTier(signals);
  tier = applyRiskMap(tier, signals, config);

  const dims = new Set(TIER_DIMENSIONS[tier]);
  // content-gated additions
  if (signals.depsChanged) dims.add('D15');
  if (signals.publicContract) dims.add('D10');
  if (signals.riskPaths.includes('migration')) dims.add('D6');
  if (signals.concurrencyTouched) dims.add('D7');
  if (signals.errorHandlingTouched) dims.add('D4');
  if (signals.typesTouched) dims.add('D11');
  if (signals.perfSensitive) dims.add('D9');
  if (signals.uiTouched) dims.add('D17');
  if (signals.languages.includes('java') || signals.languages.includes('sql')) dims.add('D6');

  const models = pickModels([...dims], tier, signals);

  const agents = [...new Set([...dims].map((d) => DIMENSION_AGENTS[d]).filter(Boolean))];

  return {
    tier,
    dimensions: [...dims],
    models,
    agents,
    runVerify: tier !== 'trivial',
    mandatoryChecks: config.mandatory_checks ?? [],
    gate: config.gate ?? { block_on: ['critical'], warn_on: ['high'] },
  };
}

// Tier C ("exhaustive") gate — the ultrareview-parity passes that cost extra
// tokens. On with --exhaustive (opts.flag) or automatically at the critical tier
// (config.exhaustive.on_critical, default true). Pure so it is unit-testable.
export function exhaustivePlan(tier, config = {}, opts = {}) {
  const exh = config.exhaustive ?? {};
  const on = opts.flag === true || (tier === 'critical' && (exh.on_critical ?? true));
  return {
    exhaustive: on,
    maxRounds: exh.max_discovery_rounds ?? 2,
    completenessCritic: on, // Tier C step 1: false-negative guard after synthesis (review.md step 8b)
    taint: on,              // Tier C step 3: route D3 verify to taint-verifier (review.md step 7)
    generativeVerify: on,   // Tier C step 2: verify may add adjacent findings (review.md step 7)
    loopUntilDry: on,       // Tier C step 4: re-sweep finders until a dry round (review.md step 6)
  };
}

function baseTier(s) {
  if (s.docOnly) return 'trivial';
  const hot = s.riskPaths.length > 0 || s.publicContract || s.concurrencyTouched;
  if (hot) return 'critical';
  if (s.fileCount <= 3 && s.netLoc <= 40 && s.testsPresent) return 'low';
  return 'standard';
}

function tierModel(tier) {
  return tier === 'trivial' ? 'haiku' : 'sonnet';
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
