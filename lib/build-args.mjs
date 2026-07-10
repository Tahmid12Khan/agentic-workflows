#!/usr/bin/env node
// CLI: assemble the Workflow `args` object from the deterministic pre-step outputs,
//      WITHOUT routing any large blob through the main agent's context window.
// Usage: node build-args.mjs --dir <scratch> > args.json
//   Reads from <scratch>: plan.json, bundle.json, diff.txt, scrutiny.json, checks.json,
//   meta.json (small: { flags, startedAt, prNumber, checkout }), OPTIONAL enrich.json
//   (small bundle patch the agent fetched via MCP: { pr, ticket, trackerUsage, ... }), and
//   OPTIONAL context.txt (the shared context pack from context-pack.mjs) and OPTIONAL
//   context-stats.json (its --stats-out sibling: size/per-section counts, inlined as
//   args.contextPackStats — small enough to carry by value, unlike the pack text itself).
//   ARGS-BY-REFERENCE: the diff and the context pack are the bulk of the payload, so args
//   carries their ABSOLUTE PATHS (diffPath, contextPackPath) — never their text. The Workflow
//   sandbox can't read files, but the agents it spawns have Read, so each reviewer/verifier
//   reads the diff file itself and focuses on its file list. This keeps args.json tiny (a few
//   KB), so the diff never enters the main agent's context OR the Workflow tool call. The only
//   diff-derived datum the sandbox needs for its own logic — the off-diff demotion — is the
//   compact `diffIndex` ({file: [[start,end]...]}), precomputed here from diff.txt.
//   Prints the assembled args object as one JSON blob on stdout — the caller redirects it to
//   args.json and reads it back exactly ONCE to hand to the Workflow tool.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffIndex, splitByFile, NOISE_RE } from './trim-diff.mjs';
import { doctrineMap } from './doctrine.mjs';
import { loadLearnings } from './memory.mjs';

// Pure: shallow-merge a small enrichment patch onto the gathered bundle. Agent-fetched
// dynamic fields (live PR object, linked ticket, trackerUsage) win over gather.mjs defaults.
export function mergeEnrich(bundle, enrich) {
  return { ...(bundle ?? {}), ...(enrich ?? {}) };
}

// Pure: compact "known false positive" digest (file + title) from the learnings store's
// acceptedFalsePositives, capped so the packet stays small — injected into every dimension-reviewer
// packet PRE-generation (review-workflow.mjs), cheaper than report.mjs's post-hoc suppression (which
// stays as a belt-and-braces backstop). memory.mjs's findingKey joins `${file}::${title}` (lowercased);
// split on the FIRST '::' since a title is vanishingly unlikely to contain it but a file path never will.
export function knownFalsePositives(learnings, max = 20) {
  return (learnings?.acceptedFalsePositives ?? []).slice(0, max).map((fp) => {
    const key = fp?.key ?? '';
    const i = key.indexOf('::');
    return i === -1 ? { file: key, title: '' } : { file: key.slice(0, i), title: key.slice(i + 2) };
  }).filter((x) => x.file || x.title);
}

// Pure: build the args object in the exact shape review-workflow.mjs destructures.
export function buildArgs({ plan, bundle, diffPath, contextPackPath, contextPackStats, diffIndex, sliceIndex, doctrinePaths, scrutiny, checks, meta, history, testSignal, knownFalsePositives }) {
  const m = meta ?? {};
  return {
    plan,
    bundle,
    diffPath,                                    // absolute path to the full unified diff — agents Read it, never inlined
    contextPackPath: contextPackPath ?? null,    // absolute path to the shared context pack; null when absent → reviewers fall back to Read/Grep
    contextPackStats: contextPackStats ?? null,  // WS7 S3: {sizeBytes,files,imports,callerHits,hop2,typeBoundary} from context-pack.mjs --stats-out; null when absent → report's coverage section omits the line
    diffIndex: diffIndex ?? {},                  // precomputed {file: [[start,end]...]} for the sandbox's off-diff demotion (no diff text needed)
    sliceIndex: sliceIndex ?? {},                // {normPath: absolute slice path} — per-file diff hunks on disk so a reviewer Reads only its files' slices, not the whole diff; {} → agents fall back to diffPath
    doctrinePaths: doctrinePaths ?? {},          // {agent: [absolute doctrine .md paths]} — WS1 review doctrine, attached by reference; reviewers Read these first (tier >= standard only); {} → no doctrine
    history: history ?? {},            // S6.3 bug-history prior (history.mjs) → intent + correctness packets; {} when absent
    testSignal: testSignal ?? null,    // S6.4 executed-test signal (test-signal.mjs) → D5 packet; null unless --run-tests ran it
    knownFalsePositives: knownFalsePositives ?? [],   // accepted-FP digest (memory.mjs) → reviewer packets pre-generation; [] when learning is disabled/empty
    shards: plan?.shards ?? [],
    routing: { scrutiny: scrutiny ?? null, checks: checks ?? null },
    flags: m.flags ?? {},
    startedAt: m.startedAt ?? null,
    prNumber: m.prNumber ?? null,
    checkout: m.checkout ?? null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const dir = arg('dir', '.');
  const readJSON = (f, def) => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch { return def; }
  };
  // plan + diff are REQUIRED — a missing one is a usage error, not a degrade. The diff text is
  // read HERE only to precompute the compact diffIndex; args carries the PATH, never the text.
  const plan = readJSON('plan.json', null);
  const diffPath = resolve(dir, 'diff.txt');
  const diffText = existsSync(diffPath) ? readFileSync(diffPath, 'utf8') : '';
  if (!plan || !diffText) {
    process.stderr.write('build-args: missing required plan.json or diff.txt in --dir\n');
    process.exit(2);
  }
  // context pack is OPTIONAL: pass its absolute path only when the file exists and is non-empty
  // (context-pack.mjs writes an empty/short file on skip/error) → else null so reviewers fall back.
  const ctxPath = resolve(dir, 'context.txt');
  const contextPackPath = (existsSync(ctxPath) && readFileSync(ctxPath, 'utf8').trim() !== '') ? ctxPath : null;
  // Pack size/per-section stats (WS7 S3), written alongside context.txt by context-pack.mjs
  // --stats-out. Optional like history.json/test-signal.json — readJSON already degrades a
  // missing/corrupt file to null.
  const contextPackStats = readJSON('context-stats.json', null);

  // Per-file diff slices (cost lever): write each changed file's hunks to <dir>/slices/<i>.patch and
  // map its normalized path → that absolute slice path. A reviewer then Reads only its files' slices
  // instead of the whole diff (the dominant input-token cost, paid once per agent). Best-effort: the
  // full diff still lives at diffPath, so any fs error just leaves sliceIndex empty and every agent
  // falls back to the full diff — never a starved reviewer. Noise (lockfiles/build artifacts, already
  // dropped from plan.files) is skipped so we don't write a huge lockfile slice no aspect references.
  const sliceIndex = {};
  try {
    const sliceDir = resolve(dir, 'slices');
    mkdirSync(sliceDir, { recursive: true });
    let i = 0;
    for (const [path, text] of Object.entries(splitByFile(diffText))) {
      if (NOISE_RE.test(path)) continue;
      const p = join(sliceDir, `${i++}.patch`);
      writeFileSync(p, text);
      sliceIndex[path] = p;
    }
  } catch { /* slicing is an optimization; on any fs error the workflow falls back to the full diff */ }

  // WS1 review doctrine (by reference): resolve the per-agent doctrine fragment basenames to absolute
  // paths under <pluginRoot>/agents/doctrine/ so the Workflow can tell a reviewer to Read them. The
  // plugin root is this script's parent's parent (lib/build-args.mjs → <root>); no env needed. Gated
  // to tier >= standard inside doctrineMap. {} on a trivial/low change → the Workflow adds no doctrine.
  const doctrineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'doctrine');
  const doctrinePaths = {};
  for (const [agent, files] of Object.entries(doctrineMap(plan.tier))) {
    doctrinePaths[agent] = files.map((f) => join(doctrineDir, f));
  }

  // Accepted false-positives, loaded PRE-generation (gated the same way respond.mjs gates the
  // feedback loop: `enabled !== false`) so the reviewer packet can say "don't re-raise these" instead
  // of only suppressing them post-hoc in report.mjs.
  const learningEnabled = plan.learning?.enabled !== false;
  const knownFPs = (learningEnabled && plan.learning?.store) ? knownFalsePositives(loadLearnings(plan.learning.store)) : [];

  const bundle = mergeEnrich(readJSON('bundle.json', {}), readJSON('enrich.json', null));
  const out = buildArgs({
    plan,
    bundle,
    diffPath,
    contextPackPath,
    contextPackStats,
    diffIndex: buildDiffIndex(diffText),
    sliceIndex,
    doctrinePaths,
    history: readJSON('history.json', {}).history ?? {},   // OPTIONAL — {} when history.mjs was skipped
    testSignal: readJSON('test-signal.json', null),        // OPTIONAL — null unless --run-tests ran it
    knownFalsePositives: knownFPs,
    scrutiny: readJSON('scrutiny.json', null),
    checks: readJSON('checks.json', null),
    meta: readJSON('meta.json', {}),
  });
  process.stdout.write(JSON.stringify(out) + '\n');
}
