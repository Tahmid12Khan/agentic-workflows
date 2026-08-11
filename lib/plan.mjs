#!/usr/bin/env node
// CLI: compute the review plan for the current branch diff.
// Reads .adversarial-code-review/config.json from cwd (optional). Prints a JSON plan to stdout.
// Usage: node plan.mjs [--base <ref>] [--tier <t>] [--dimensions D2,D3]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { computeSignals, changeSizingAdvisory, moduleSpecifiers } from './signals.mjs';
import { planReview, exhaustivePlan, pickModels, applyEffort, EFFORT_LEVELS, DIMENSION_AGENTS, DIMENSION_LABELS } from './triage.mjs';
import { shouldShard, shardFiles, singleShard, cappedMaxShards, selectReviewFiles } from './shard.mjs';
import { shouldFunnel, funnelFiles } from './funnel.mjs';
import { verifyPolicy } from './verify.mjs';
import { NOISE_RE } from './trim-diff.mjs';
import { loadLastReview, resolveIncrementalRange } from './memory.mjs';

// WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the
// new name; fall back to the old one only if it's the ONLY one present — supports un-migrated
// installs for one release cycle.
const ACR_DIR = (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
  ? '.adverserial-code-review'
  : '.adversarial-code-review';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function git(args) {
  // maxBuffer: the full `git diff` for signal detection (line ~95) flows through here. At Node's
  // default 1 MB a large PR's diff overflows → throws → caught → diff='' → every content signal reads
  // false → tier silently collapses to "standard" and gated dims never fire. Match the other full-diff
  // captures (capture-diff 256 MB) so big PRs are tiered/gated on their real content.
  return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).toString();
}
// Exit 0 = a is an ancestor of b (fast-forward). Exit 1 (not an ancestor) and exit 128 (missing
// object, e.g. a prevHead that was force-pushed away) both throw here → false → the incremental
// range resolver fails open to a full review.
function isAncestor(a, b) {
  try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: ['pipe', 'pipe', 'pipe'] }); return true; }
  catch { return false; }
}

// --- resolve base/head ---
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty tree
const head = git(['rev-parse', 'HEAD']).trim();
function resolveBase(explicit) {
  if (explicit) return explicit.trim();
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      const mb = git(['merge-base', 'HEAD', ref]).trim();
      if (mb && mb !== head) return mb; // skip when we're ON the base branch (would be an empty diff)
    } catch { /* try next */ }
  }
  try { return git(['rev-parse', 'HEAD~1']).trim(); } catch { return EMPTY_TREE; }
}
const base = resolveBase(arg('--base'));
let range = `${base}..${head}`;

// --- incremental narrowing (S9): opt-in via --incremental; --full forces a complete review ---
// Default OFF. When requested, narrow the reviewed range to only the commits added since the last
// review (prevHead..head) — but ONLY on a fast-forward advance; resolveIncrementalRange fails open to
// the full base..head on any rebase/force-push/missing state so rewritten commits are never skipped.
const wantIncremental = process.argv.includes('--incremental');
const forceFull = process.argv.includes('--full');
let incremental = { requested: wantIncremental, applied: false, prevHead: null, reason: forceFull ? '--full: forced a complete review' : null };
if (wantIncremental && !forceFull) {
  // --incremental-from <sha> lets a caller (the pr-review-loop) name the previously-reviewed head
  // directly — needed when the review runs in a throwaway worktree that has no local
  // .adversarial-code-review/last-review.json state to read. Falls back to that store otherwise.
  const prevHead = arg('--incremental-from') ?? loadLastReview(`${ACR_DIR}/last-review.json`)?.head ?? null;
  const dec = resolveIncrementalRange({ base, head, prevHead, isAncestor });
  range = dec.range;
  incremental = { requested: true, applied: dec.incremental, prevHead: dec.prevHead, reason: dec.reason };
}

// --- raw diff data ---
// NOISE_RE (lib/trim-diff.mjs) is the single source of truth for mechanically-generated /
// vendored paths — the same constant scopes the noise-strip applied to the Intent-phase diff.
const allFiles = git(['diff', '--name-only', range]).split('\n').map((s) => s.trim()).filter(Boolean);
const files = allFiles.filter((f) => !NOISE_RE.test(f));

let netLoc = 0, added = 0, deleted = 0;
const locByFile = new Map();   // per-file churn, used only to prioritise which files to keep if capped
try {
  for (const row of git(['diff', '--numstat', range]).split('\n')) {
    const [add, del, path] = row.split('\t');
    if (!path || NOISE_RE.test(path)) continue;
    const a = Number(add) || 0, d = Number(del) || 0;   // '-' (binary) → NaN → 0
    added += a;
    deleted += d;
    locByFile.set(path, a + d);
  }
  netLoc = added + deleted;
} catch { /* shallow / no history */ }
// Rename count (WS1 change-size exemption): a change that is mostly mechanical renames should not
// trigger the size advisory. Best-effort — a shallow/no-history repo just leaves it 0.
let renames = 0;
try {
  for (const row of git(['diff', '--name-status', '-M', range]).split('\n')) {
    if (/^R\d/.test(row.trim())) renames++;
  }
} catch { /* shallow / no history */ }

let diff = '';
try { diff = git(['diff', range]); } catch { try { diff = git(['show', '--patch', 'HEAD']); } catch { diff = ''; } }

// --- heuristic signals from paths + diff content ---
const DEP = /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|requirements\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json)$|\.lock$/i;
const TEST = /(test|spec|__tests__)/i;
const CONCURRENCY = /\b(synchronized|@Async|Executor|ExecutorService|threading\.|asyncio|Promise\.all|new\s+Lock|Mutex|volatile|AtomicInteger|CompletableFuture|FOR UPDATE|SKIP LOCKED|saga|idempotenc)/i;
const CONTRACT_FILE = /\.proto$|openapi|swagger|graphql|(^|\/)controller/i;
const CONTRACT_DIFF = /^[+-]\s*(export\s|public\s+(class|interface|enum)\s|@(Request|Get|Post|Put|Delete|Patch)Mapping)/m;
const ERRH = /^[+-].*\b(try|catch|except|rescue|finally|throw|raise|panic|recover|\.catch\(|err\s*!=\s*nil)\b/m;
const TYPES = /^[+-]\s*(export\s+)?(interface|type\s+\w+\s*=|class\s|enum\s|struct\s|@dataclass|record\s)/m;
const PERF = /\b(for\s*\(.*\b(query|find|select|fetch)|N\+1|\.map\(.*await|nested loop|O\(n\^2\)|cache|Cacheable|pagination|LIMIT|OFFSET|stream|backpressure)\b/i;
const LLM = /\b(anthropic|openai|\bllm\b|chat\.completions|messages\.create|claude-|gpt-|prompt)\b/i;

const change = {
  files,
  netLoc,
  depsChanged: allFiles.some((f) => DEP.test(f)),
  testsPresent: files.some((f) => TEST.test(f)),
  concurrencyTouched: CONCURRENCY.test(diff),
  errorHandlingTouched: ERRH.test(diff),
  typesTouched: TYPES.test(diff),
  perfSensitive: PERF.test(diff),
  callsLlm: LLM.test(diff),
  publicContract: files.some((f) => CONTRACT_FILE.test(f)) || CONTRACT_DIFF.test(diff),
};

// --- config ---
let config = {};
if (existsSync(`${ACR_DIR}/config.json`)) {
  try { config = JSON.parse(readFileSync(`${ACR_DIR}/config.json`, 'utf8')); } catch { /* ignore */ }
}

// --- review instructions (REVIEW.md): the highest-priority, review-SPECIFIC guidance. Its CONTENT
// (not just a path, unlike project_rules) is injected verbatim as a cache-leading MANDATORY block
// into the finding-generating agents (reviewers + intent + critic) in review-workflow.mjs. Config
// key wins; defaults to REVIEW.md by convention. Capped at 8k like project_rules content so it stays
// a cheap, byte-identical prefix that prompt-caches across aspects. '' when absent → the block is a no-op.
const reviewInstructionsPath = config.review_instructions ?? 'REVIEW.md';
let reviewInstructions = '';
if (reviewInstructionsPath && existsSync(reviewInstructionsPath)) {
  try { reviewInstructions = readFileSync(reviewInstructionsPath, 'utf8').slice(0, 8000); } catch { /* unreadable → skip, never crash */ }
}

const signals = computeSignals(change);

// --- overrides ---
const tierOverride = arg('--tier');
// --max-tier clamps ONLY the auto-computed tier (the loop's budget cap); an explicit --tier is
// authoritative and ignores it. recompute the whole plan from the resulting tier, don't relabel.
const maxTier = arg('--max-tier');

// --effort (WS4): USER INTENT for this run (noise tolerance / verification depth) — orthogonal to
// --tier (risk of the change) and parsed alongside it. Unknown/absent → 'medium' (today's behavior,
// untouched). low/max reach into config.fanout HERE, before planReview() computes dimensions —
// lever D (fan-out trim) lives inside planReview and it is too late to un-trim after the fact.
const effortArg = arg('--effort');
const effort = EFFORT_LEVELS.includes(effortArg) ? effortArg : 'medium';
if (effort === 'low') config = { ...config, fanout: { ...(config.fanout ?? {}), trim: true } };   // force fan-out trim ON (config's own knobs still win)
if (effort === 'max') config = { ...config, fanout: { ...(config.fanout ?? {}), trim: false } };  // max: no fan-out trim — full specialist coverage

let plan = planReview(signals, config, tierOverride, maxTier);

// --- blast-radius escalation (fan-in): a one-line change to a widely-imported module can slip to
// low/standard tier on lexical signals alone (signals.mjs never looks at WHO imports the file). Only
// worth the git-grep cost when it could actually change the outcome: no explicit --tier (authoritative,
// same as risk_map) and the tier so far is low/standard (higher tiers already review deeply; trivial
// stays trivial). Capped to the first 10 changed files so a large diff can't blow up the cost.
const faninThreshold = config.fanin_threshold ?? 20;
if (!tierOverride && faninThreshold > 0 && (plan.tier === 'low' || plan.tier === 'standard')) {
  const capped = files.slice(0, 10);
  const preNotes = capped.length < files.length
    ? [`fan-in check capped at first ${capped.length} of ${files.length} changed files`]
    : [];
  let fanIn = null;
  for (const f of capped) {
    const specifiers = moduleSpecifiers(f);
    let hits = [];
    try {
      hits = git(['grep', '-lI', '--fixed-strings', ...specifiers.flatMap((s) => ['-e', s])])
        .split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { hits = []; } // no matches (git grep exits 1) or not a repo — degrade to 0 fan-in
    const count = new Set(hits.filter((h) => !files.includes(h))).size;
    if (count > 0 && (!fanIn || count > fanIn.count)) fanIn = { count, file: f };
  }
  if (fanIn) plan = planReview(signals, config, tierOverride, maxTier, fanIn);
  plan.notes = [...preNotes, ...(plan.notes ?? [])];
}

const dimOverride = arg('--dimensions');
if (dimOverride) {
  const requested = dimOverride.split(',').map((s) => s.trim()).filter(Boolean);
  // D1/D2/D12 (correctness-reviewer) are always-on and cannot be opted out
  plan.dimensions = [...new Set(['D1', 'D2', 'D12', ...requested])];
  plan.agents = [...new Set(plan.dimensions.map((d) => DIMENSION_AGENTS[d]).filter(Boolean))];
  plan.models = pickModels(plan.dimensions, plan.tier, signals, config); // recompute so a new dim isn't left model-less
  plan.trimmed = []; // explicit --dimensions supersedes lever D
}

// --- sharding for large diffs ---
const ld = config.large_diff ?? {};
const threshold = ld.shard_threshold_loc ?? 600;
// Fan-out ceiling: bound total review aspects on a large diff so many-dimension changes don't spawn a
// runaway agent count (each agent is an API call → more 529 exposure + cost). vuln-reviewer (D3) is
// unsharded (one full-diff aspect), so only the other agents multiply by shard count.
const maxAspects = ld.max_review_aspects ?? 40;
const shardedAgents = Math.max(1, (plan.agents ?? []).filter((a) => a !== 'vuln-reviewer').length);
const maxShards = cappedMaxShards(ld.max_shards ?? 4, shardedAgents, maxAspects);
// Hard file-count ceiling (see selectReviewFiles): args.json grows one entry per reviewed file and the
// orchestrator must emit it verbatim into the Workflow call, so an unbounded file count eventually drops
// mid-response. Cap the reviewed set to the highest-risk `max_review_files` and WARN. tier/signals/
// advisories above stay computed on the FULL change (true blast radius); only the reviewed file list —
// which drives shards, the per-file diff slices, and diffRanges — is trimmed.
const maxReviewFiles = ld.max_review_files ?? 200;

// --- mega-PR funnel (#10): for a change far beyond max_review_files, sample mechanical-looking
// clusters (boilerplate-shaped groups of files) instead of blind-dropping the lowest-ranked tail.
// mega_pr.threshold defaults higher than max_review_files, so BELOW it this is a no-op and
// selectReviewFiles alone decides what's reviewed — byte-for-byte the same as before this feature
// existed. Above it, the funnel narrows the set first; selectReviewFiles then still runs on its
// OUTPUT as a belt-and-braces ceiling (the funnel reduces bulk but sets no hard cap of its own — a
// mega-PR with no qualifying mechanical cluster would otherwise stay just as large).
const megaPr = config.mega_pr ?? {};
const megaThreshold = megaPr.threshold ?? 250;
let reviewFiles, filesCapped, filesFunneled = null;
if (shouldFunnel(files.length, megaThreshold)) {
  const funneled = funnelFiles(files, {
    riskPaths: signals.riskPaths,
    locByFile,
    threshold: megaThreshold,
    clusterMin: megaPr.cluster_min ?? 8,
    churnTolerance: megaPr.churn_tolerance ?? 0.3,
    sampleRate: megaPr.sample_rate ?? 0.15,
    clusterMinSample: megaPr.cluster_min_sample ?? 3,
  });
  filesFunneled = funneled.summary;
  const sel = selectReviewFiles(funneled.files, { max: maxReviewFiles, riskPaths: signals.riskPaths, locByFile });
  reviewFiles = sel.files;
  filesCapped = sel.capped;
} else {
  const sel = selectReviewFiles(files, { max: maxReviewFiles, riskPaths: signals.riskPaths, locByFile });
  reviewFiles = sel.files;
  filesCapped = sel.capped;
}
const sharded = shouldShard(netLoc, reviewFiles.length, threshold);
const shards = sharded ? shardFiles(reviewFiles, { maxShards }) : singleShard(reviewFiles);

const vp = verifyPolicy(config, plan.tier); // tier resolves verify.by_tier.<tier> over the flat keys
const esc = config.escalation ?? {};
// max effort implies --exhaustive (the "high's thresholds + exhaustive + no fan-out trim" combo);
// --exhaustive alone still works standalone, and --exhaustive + --effort low legally combine —
// exhaustive wins on PASSES (this flag), low wins on the REPORT threshold (applyEffort, below).
const discovery = exhaustivePlan(plan.tier, config, { flag: process.argv.includes('--exhaustive') || effort === 'max' });

// Apply effort to the ALREADY-RESOLVED verify budget (thresholds/caps only — never plan.tier or
// plan.gate; see lib/triage.mjs applyEffort). Its output re-merges into out.verify below, which
// auto-propagates to the Workflow sandbox (it consumes plan.verify as-is) with no further wiring.
const effortPlan = applyEffort({ tier: plan.tier, gate: plan.gate, verify: { reportConfidence: vp.reportConfidence, maxVerifierAgents: vp.maxVerifierAgents } }, effort);

// WS1 process advisories: deterministic, zero-model-cost change-size signal (never gate-affecting;
// rendered in its own "Process advisories" report section). Rides in the plan → report payload.
const processAdvisories = changeSizingAdvisory({ added, deleted, fileCount: files.length, renames });

const out = {
  base,
  head,
  range,
  // Incremental-review decision (S9): { requested, applied, prevHead, reason }. `applied:false` means
  // the reviewed range is the full base..head (default, or a fall-open from a non-fast-forward head).
  incremental,
  tier: plan.tier,
  effort: effortPlan.effort, // WS4: user intent for this run (report/verify thresholds+caps) — never the risk tier
  dimensions: plan.dimensions,
  dimensionLabels: Object.fromEntries(plan.dimensions.map((d) => [d, DIMENSION_LABELS[d] ?? d])),
  agents: plan.agents,
  dimensionAgents: Object.fromEntries(plan.dimensions.map((d) => [d, DIMENSION_AGENTS[d]]).filter(([, a]) => a)),
  // Full catalog so the Workflow can resolve a dimension triage-classifier ADDS at
  // runtime (addDimensions) to its reviewer agent — the sandbox can't import triage.mjs.
  dimensionAgentsAll: DIMENSION_AGENTS,
  trimmed: plan.trimmed ?? [],
  // Human-readable explanations for auto-tier decisions beyond risk_map — currently just the
  // blast-radius fan-in escalation (and its "capped at N files" note). [] when nothing fired.
  notes: plan.notes ?? [],
  models: plan.models,
  runVerify: plan.runVerify,
  // Resolved ONCE here (plan.mjs can import verify.mjs); the Workflow sandbox consumes this object
  // as-is — it must NOT re-resolve raw config (it has no fs/import). camelCase throughout.
  verify: {
    maxPassesPerAspect: vp.maxPassesPerAspect,
    maxVerifierPasses: vp.maxVerifierPasses,
    maxSubagentsPerAspect: vp.maxSubagentsPerAspect,
    // Batched-verify budget: at most maxVerifierAgents groups (all on verifyModel), + 1 reverify guard.
    // WS4: maxVerifierAgents/reportConfidence come from effortPlan (effort-adjusted), not vp directly —
    // 'medium' is an identity pass-through so this is byte-identical to vp's values by default.
    maxVerifierAgents: effortPlan.verify.maxVerifierAgents,
    verifyModel: vp.verifyModel,
    reverifyBelow: vp.reverifyBelow,
    reportConfidence: effortPlan.verify.reportConfidence,
    escalateUncertain: vp.escalateUncertain,
    modelFirst: vp.modelFirst,
    modelEscalate: vp.modelEscalate,
    escalateDirectSeverity: vp.escalateDirectSeverity,
  },
  escalation: {
    maxSubagentsPerAspect: esc.max_subagents_per_aspect ?? 3,
  },
  exhaustive: discovery.exhaustive,
  discovery,
  // Diff-scope demotion (S1.1): findings anchored > slack lines outside the change are
  // demoted to advisory-only (excluded from verdict/gate/comments). camelCase for the sandbox.
  diffScope: { slack: config.diff_scope?.slack ?? 3 },
  sharded,
  shards,
  scan: config.scan ?? { deps: true, tests: false, lint: false },
  learning: config.learning ?? { enabled: true, store: `${ACR_DIR}/learnings.json` },
  notify: config.notify ?? { ask_on_unresolved: true },
  trackers: config.trackers ?? {},
  mandatoryChecks: plan.mandatoryChecks,
  gate: plan.gate,
  intentSources: config.intent_sources ?? { pr: true, commits: true, pr_comments: true, clickup: true, jira: true },
  projectRules: config.project_rules ?? [],
  reviewInstructions,
  reviewInstructionsPath: reviewInstructions ? reviewInstructionsPath : null,
  fileCount: files.length,
  netLoc,
  // WS1: deterministic change-size process advisories (advisory-only, never gate-affecting). [] when
  // the change is small / a pure deletion / mostly renames. report.mjs renders them in their own section.
  processAdvisories,
  files: reviewFiles,   // the files ACTUALLY reviewed (capped); fileCount above stays the true total
  // Present only when the change exceeded max_review_files and some files were dropped from review;
  // report.mjs renders it as a WARN. null (absent) otherwise.
  filesCapped,
  // Present only when the change exceeded mega_pr.threshold and the funnel engaged (#10); report.mjs
  // renders it as a WARN alongside filesCapped. null (absent) otherwise — a normal-sized PR's plan
  // carries no new field at all.
  filesFunneled,
  signals: { riskPaths: signals.riskPaths, languages: signals.languages, callsLlm: signals.callsLlm },
  diffSummary: `${files.length} files, ~${netLoc} LOC, langs: ${signals.languages.join(',') || 'n/a'}, risk: ${signals.riskPaths.join(',') || 'none'}${filesFunneled ? `, funneled: ${filesFunneled.hot} hot + ${filesFunneled.sampled}/${filesFunneled.mechanicalTotal} mechanical sampled` : ''}${filesCapped ? `, reviewing ${filesCapped.reviewed}/${filesCapped.total}${filesFunneled ? ' funnel candidates' : ''} (capped)` : ''}${sharded ? `, ${shards.length} shards` : ''}`,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
