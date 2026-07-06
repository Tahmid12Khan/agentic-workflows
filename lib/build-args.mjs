#!/usr/bin/env node
// CLI: assemble the Workflow `args` object from the deterministic pre-step outputs,
//      WITHOUT routing any large blob through the main agent's context window.
// Usage: node build-args.mjs --dir <scratch> > args.json
//   Reads from <scratch>: plan.json, bundle.json, diff.txt, scrutiny.json, checks.json,
//   meta.json (small: { flags, startedAt, prNumber, checkout }), OPTIONAL enrich.json
//   (small bundle patch the agent fetched via MCP: { pr, ticket, trackerUsage, ... }), and
//   OPTIONAL context.txt (the shared context pack from context-pack.mjs).
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
import { join, resolve } from 'node:path';
import { buildDiffIndex, splitByFile, NOISE_RE } from './trim-diff.mjs';

// Pure: shallow-merge a small enrichment patch onto the gathered bundle. Agent-fetched
// dynamic fields (live PR object, linked ticket, trackerUsage) win over gather.mjs defaults.
export function mergeEnrich(bundle, enrich) {
  return { ...(bundle ?? {}), ...(enrich ?? {}) };
}

// Pure: build the args object in the exact shape review-workflow.mjs destructures.
export function buildArgs({ plan, bundle, diffPath, contextPackPath, diffIndex, sliceIndex, scrutiny, checks, meta, history, testSignal }) {
  const m = meta ?? {};
  return {
    plan,
    bundle,
    diffPath,                                    // absolute path to the full unified diff — agents Read it, never inlined
    contextPackPath: contextPackPath ?? null,    // absolute path to the shared context pack; null when absent → reviewers fall back to Read/Grep
    diffIndex: diffIndex ?? {},                  // precomputed {file: [[start,end]...]} for the sandbox's off-diff demotion (no diff text needed)
    sliceIndex: sliceIndex ?? {},                // {normPath: absolute slice path} — per-file diff hunks on disk so a reviewer Reads only its files' slices, not the whole diff; {} → agents fall back to diffPath
    history: history ?? {},            // S6.3 bug-history prior (history.mjs) → intent + correctness packets; {} when absent
    testSignal: testSignal ?? null,    // S6.4 executed-test signal (test-signal.mjs) → D5 packet; null unless --run-tests ran it
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

  const bundle = mergeEnrich(readJSON('bundle.json', {}), readJSON('enrich.json', null));
  const out = buildArgs({
    plan,
    bundle,
    diffPath,
    contextPackPath,
    diffIndex: buildDiffIndex(diffText),
    sliceIndex,
    history: readJSON('history.json', {}).history ?? {},   // OPTIONAL — {} when history.mjs was skipped
    testSignal: readJSON('test-signal.json', null),        // OPTIONAL — null unless --run-tests ran it
    scrutiny: readJSON('scrutiny.json', null),
    checks: readJSON('checks.json', null),
    meta: readJSON('meta.json', {}),
  });
  process.stdout.write(JSON.stringify(out) + '\n');
}
