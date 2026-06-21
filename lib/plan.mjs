#!/usr/bin/env node
// CLI: compute the review plan for the current branch diff.
// Reads .adverserial-code-review/config.json from cwd (optional). Prints a JSON plan to stdout.
// Usage: node plan.mjs [--base <ref>] [--tier <t>] [--dimensions D2,D3]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { computeSignals } from './signals.mjs';
import { planReview, exhaustivePlan, pickModels, DIMENSION_AGENTS, DIMENSION_LABELS } from './triage.mjs';
import { shouldShard, shardFiles, singleShard } from './shard.mjs';
import { verifyPolicy } from './verify.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function git(args) {
  return execFileSync('git', args, { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
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
const range = `${base}..${head}`;

// --- raw diff data ---
const NOISE = /(^|\/)(dist|build|out|coverage|node_modules)\/|\.(lock|min\.js|map|snap|pb\.go)$|(^|\/)package-lock\.json$/i;
const allFiles = git(['diff', '--name-only', range]).split('\n').map((s) => s.trim()).filter(Boolean);
const files = allFiles.filter((f) => !NOISE.test(f));

let netLoc = 0;
try {
  for (const row of git(['diff', '--numstat', range]).split('\n')) {
    const [add, del, path] = row.split('\t');
    if (!path || NOISE.test(path)) continue;
    netLoc += (Number(add) || 0) + (Number(del) || 0);
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
if (existsSync('.adverserial-code-review/config.json')) {
  try { config = JSON.parse(readFileSync('.adverserial-code-review/config.json', 'utf8')); } catch { /* ignore */ }
}

const signals = computeSignals(change);

// --- overrides ---
const tierOverride = arg('--tier');
// recompute the whole plan from the forced tier (dims/models/runVerify), don't relabel
let plan = planReview(signals, config, tierOverride);
const dimOverride = arg('--dimensions');
if (dimOverride) {
  const requested = dimOverride.split(',').map((s) => s.trim()).filter(Boolean);
  // D1/D2/D12 (correctness-reviewer) are always-on and cannot be opted out
  plan.dimensions = [...new Set(['D1', 'D2', 'D12', ...requested])];
  plan.agents = [...new Set(plan.dimensions.map((d) => DIMENSION_AGENTS[d]).filter(Boolean))];
  plan.models = pickModels(plan.dimensions, plan.tier, signals); // recompute so a new dim isn't left model-less
}

// --- sharding for large diffs ---
const ld = config.large_diff ?? {};
const threshold = ld.shard_threshold_loc ?? 600;
const maxShards = ld.max_shards ?? 4;
const sharded = shouldShard(netLoc, files.length, threshold);
const shards = sharded ? shardFiles(files, { maxShards }) : singleShard(files);

const vp = verifyPolicy(config);
const esc = config.escalation ?? {};
const discovery = exhaustivePlan(plan.tier, config, { flag: process.argv.includes('--exhaustive') });

const out = {
  base,
  head,
  range,
  tier: plan.tier,
  dimensions: plan.dimensions,
  dimensionLabels: Object.fromEntries(plan.dimensions.map((d) => [d, DIMENSION_LABELS[d] ?? d])),
  agents: plan.agents,
  dimensionAgents: Object.fromEntries(plan.dimensions.map((d) => [d, DIMENSION_AGENTS[d]]).filter(([, a]) => a)),
  models: plan.models,
  runVerify: plan.runVerify,
  verify: {
    maxPassesPerAspect: vp.maxPassesPerAspect,
    maxVerifierPasses: vp.maxVerifierPasses,
    maxSubagentsPerAspect: vp.maxSubagentsPerAspect,
    reverifyBelow: vp.reverifyBelow,
    reportConfidence: vp.reportConfidence,
    escalateUncertain: vp.escalateUncertain,
  },
  escalation: {
    maxSubagentsPerAspect: esc.max_subagents_per_aspect ?? 3,
  },
  exhaustive: discovery.exhaustive,
  discovery,
  sharded,
  shards,
  scan: config.scan ?? { deps: true, tests: false, lint: false },
  reportTargets: config.report ?? { markdown: 'REVIEW.md', html: 'REVIEW.html' },
  learning: config.learning ?? { enabled: true, store: '.adverserial-code-review/learnings.json' },
  notify: config.notify ?? { ask_on_unresolved: true },
  trackers: config.trackers ?? {},
  mandatoryChecks: plan.mandatoryChecks,
  gate: plan.gate,
  intentSources: config.intent_sources ?? { pr: true, commits: true, pr_comments: true },
  projectRules: config.project_rules ?? [],
  fileCount: files.length,
  netLoc,
  files,
  signals: { riskPaths: signals.riskPaths, languages: signals.languages, callsLlm: signals.callsLlm },
  diffSummary: `${files.length} files, ~${netLoc} LOC, langs: ${signals.languages.join(',') || 'n/a'}, risk: ${signals.riskPaths.join(',') || 'none'}${sharded ? `, ${shards.length} shards` : ''}`,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
