#!/usr/bin/env node
// CLI: assemble the Workflow `args` object from the deterministic pre-step outputs,
//      WITHOUT routing any large blob through the main agent's context window.
// Usage: node build-args.mjs --dir <scratch> > args.json
//   Reads from <scratch>: plan.json, bundle.json, diff.txt, scrutiny.json, checks.json,
//   meta.json (small: { flags, startedAt, prNumber, checkout }), and OPTIONAL enrich.json
//   (small bundle patch the agent fetched via MCP: { pr, ticket, trackerUsage, ... }).
//   Prints the assembled args object as one JSON blob on stdout — the caller redirects it
//   to args.json and reads it back exactly ONCE to hand to the Workflow tool. The diff
//   (the bulk of the payload) is read from disk here and never enters the agent's context.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Pure: shallow-merge a small enrichment patch onto the gathered bundle. Agent-fetched
// dynamic fields (live PR object, linked ticket, trackerUsage) win over gather.mjs defaults.
export function mergeEnrich(bundle, enrich) {
  return { ...(bundle ?? {}), ...(enrich ?? {}) };
}

// Pure: build the args object in the exact shape review-workflow.mjs destructures.
export function buildArgs({ plan, bundle, diff, scrutiny, checks, meta }) {
  const m = meta ?? {};
  return {
    plan,
    bundle,
    diff,
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
  const readText = (f) => {
    try { return readFileSync(join(dir, f), 'utf8'); }
    catch { return ''; }
  };

  // plan + diff are REQUIRED — a missing one is a usage error, not a degrade.
  const plan = readJSON('plan.json', null);
  const diff = readText('diff.txt');
  if (!plan || !diff) {
    process.stderr.write('build-args: missing required plan.json or diff.txt in --dir\n');
    process.exit(2);
  }

  const bundle = mergeEnrich(readJSON('bundle.json', {}), readJSON('enrich.json', null));
  const out = buildArgs({
    plan,
    bundle,
    diff,
    scrutiny: readJSON('scrutiny.json', null),
    checks: readJSON('checks.json', null),
    meta: readJSON('meta.json', {}),
  });
  process.stdout.write(JSON.stringify(out) + '\n');
}
