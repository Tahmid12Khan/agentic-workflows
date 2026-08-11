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
//   compact `diffRanges`, precomputed here from diff.txt and keyed by the DERIVED slice name
//   (trim-diff.mjs `sliceName`) rather than by path — the sandbox re-derives that key from a
//   finding's own path, so it never needs the reviewed file list at all.
//   The file list itself is by reference too: per-shard MANIFESTS ("<path>\t<slice>" per line) go to
//   <scratch>/manifests/ and args carries {label, count, manifest} per shard, not a path per file.
//   Net effect on a 69-file PR: args went 42 KB → ~11 KB, well clear of the mid-response drop point.
//   BUNDLE PARTS (on top of manifests): alongside each manifest, that shard's slice CONTENT is also
//   concatenated into a handful of "bundle parts" under <scratch>/bundles/ (bundleParts()), so the
//   normal path for a reviewer is to Read a few bundle parts in one batch instead of one slice per
//   file — manifests + individual slices still get written and remain the automatic fallback a
//   reviewer/verifier/critic falls back to if a bundle write fails. allParts (the whole-diff bundle)
//   is what D3/vuln and intent-analyzer Read instead of the bare, unsliced diff.
//   Prints the assembled args object as one JSON blob on stdout — the caller redirects it to
//   args.json and reads it back exactly ONCE to hand to the Workflow tool.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffIndex, splitByFile, normPath, sliceName } from './trim-diff.mjs';
import { doctrineMap } from './doctrine.mjs';
import { loadLearnings } from './memory.mjs';
import { routedFiles } from './review-orchestration.mjs';

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

// Pure: the changed-line ranges for the reviewed files, keyed by SLICE NAME rather than by path.
// The sandbox already knows every reviewed path (it rebuilds plan.files from args.shards), so
// repeating each one as an index key was a second full copy of the file list in the payload the
// orchestrator must emit verbatim. Keying by the derived slice name costs ~7 characters instead.
// A reviewed file absent from the diff gets NO entry — same as the old path-keyed index, so
// inDiffScope still demotes findings on it.
export function rangesBySliceName(index, files) {
  return Object.fromEntries((files ?? [])
    .map((f) => [sliceName(f), (index ?? {})[normPath(f)]])
    .filter(([, ranges]) => ranges !== undefined));
}

// Pure: the manifest BODY for a set of files — one "<path>\t<absolute slice path>" per line, or the
// bare path when slicing is off. This is the file list BY REFERENCE: `args.shards` used to inline one
// long repo path per reviewed file, which on a 69-file PR was 6.5 KB — the largest single term in the
// blob the orchestrator model must emit verbatim into the Workflow call (and again into the returned
// report payload), and therefore the largest remaining contributor to mid-response transcription drift.
// Every consumer of that list is an AGENT with Read, so the list belongs on disk; the sandbox only ever
// needed the shard LABEL and COUNT. Column 2 doubles as the reviewer's read list, so one Read of the
// manifest replaces both "which files are mine" and "where are their hunks".
// Column 1 is the RAW repo path, exactly as plan.files carried it — this is a path an agent will
// Read, and normPath() strips a leading "a/" or "b/" (it exists to unprefix DIFF HEADER paths), so
// normalizing here would hand the reviewer "b.js" for a real file at "a/b.js". Only the slice NAME is
// derived from the normalized form, which is what build-args wrote the slice under.
export function manifestText(files, sliceDir) {
  const lines = (files ?? []).map((f) => {
    const p = String(f ?? '');
    return sliceDir ? `${p}\t${join(sliceDir, sliceName(p))}` : p;
  });
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// Pure: the ONE aggregate note pushed when dimension routing (#9) narrowed at least one (shard,
// agent) pair this run — a single summary line, not one per shard/agent, so visibility into the
// mechanism doesn't itself grow the payload. null when nothing narrowed (no note to add).
export function routingNote(narrowedPairs, narrowedFiles, fullFiles) {
  if (!narrowedPairs) return null;
  return `dimension routing narrowed ${narrowedPairs} (shard, agent) pair(s) to ${narrowedFiles}/${fullFiles} files total`;
}

// Pure: a filesystem-safe manifest basename for a shard. Shard labels are directory names, and
// shard.mjs joins merged ones with '+' ("api+web"), so a label can carry '/' and other path
// characters; the index prefix keeps two shards that sanitize to the same string distinct.
export function manifestName(label, i) {
  const safe = String(label ?? 'shard').replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 40);
  return `${i}-${safe}.files`;
}

// Pure: concatenate an ordered file list's diff-slice CONTENT (from the in-memory `byFile` map
// splitByFile() already produced — no disk I/O here) into "bundle parts" capped under the Read
// tool's line/byte limit, so a reviewer Reads a handful of parts instead of one slice per file.
// Each file's content is preceded by a "=== FILE: <path> ===" header so a reviewer can still
// tell which hunks belong to which file from the concatenated text alone. A file with no byFile
// entry (no textual hunks — rename/mode-change/binary) gets the SAME placeholder line
// build-args.mjs already writes to its slice file, so a bundle never silently omits a file.
// Never splits a single file's content across two parts (a reviewer must see one file's hunks
// whole) — an oversized single file becomes one oversized part, same as today's per-slice Read of
// that file (no new regression). Deterministic: stable input order, no Date/Math.random.
// Defaults sized to the REAL Read-tool per-call limit, not a theoretical one: verified empirically
// that Read truncates around ~25,000 tokens per call (a 134,420-byte/1,061-line file came back as
// only 100 lines with a "cap 25000" notice). 1,800 lines / 200KB was 2-3x over that on real diff
// content (~74 bytes/line average on a measured large PR), so a part would routinely arrive
// truncated instead of whole. 800 lines / 60KB leaves margin for denser diffs.
export function bundleParts(files, byFile, { maxLines = 800, maxBytes = 60_000 } = {}) {
  const parts = [];
  let current = '';
  let currentLines = 0;
  for (const f of files ?? []) {
    const path = normPath(f);
    const content = byFile[path] ?? `(no textual hunks for ${path} — rename, mode change, or binary)\n`;
    const chunk = `=== FILE: ${path} ===\n${content}`;
    const chunkLines = chunk.split('\n').length;
    const wouldOverflow = current && (currentLines + chunkLines > maxLines
      || Buffer.byteLength(current, 'utf8') + Buffer.byteLength(chunk, 'utf8') > maxBytes);
    if (wouldOverflow) { parts.push(current); current = ''; currentLines = 0; }
    current += chunk;
    currentLines += chunkLines;
  }
  if (current) parts.push(current);
  return parts;
}

// Pure: the skip note for a context pack that was ATTEMPTED but came back empty. context-pack.mjs
// writes a zero-byte file on skip or crash, which reads here as "no pack at all" — indistinguishable
// in the report from a run where the pre-step legitimately never ran. Golden rule 3 says degrade to a
// NOTE, not to silence: without one, every reviewer quietly loses its pre-read context (enclosing
// definitions, imports, callers) and nothing in the output says the review was thinner than usual.
// Returns [] when the pack is present, or when no context.txt exists at all.
export function contextPackNote(packExists, packPath) {
  return (packExists && !packPath)
    ? ['context pack was built but came back EMPTY — reviewers fell back to their own Read/Grep (see context-pack.mjs stderr)']
    : [];
}

// Pure: the first pair of reviewed files whose paths derive the SAME slice name, or null. Two
// distinct files sharing a slice would silently share both their hunks and their diff-scope
// ranges — rare enough to never see, wrong enough to refuse. The caller disables slicing and
// falls back to the legacy path-keyed index when this returns non-null.
export function sliceNameCollision(files) {
  const seen = new Map();
  for (const f of files ?? []) {
    const name = sliceName(f);
    const path = normPath(f);
    const prior = seen.get(name);
    if (prior !== undefined && prior !== path) return `${prior} / ${path}`;
    seen.set(name, path);
  }
  return null;
}

// Pure: build the args object in the exact shape review-workflow.mjs destructures.
export function buildArgs({ plan, bundle, diffPath, contextPackPath, contextPackStats, diffIndex, diffRanges, sliceDir, contextDir, doctrineText, scrutiny, checks, meta, historyPath, testSignal, knownFalsePositives, shards, allManifest, allParts, buildNotes }) {
  const m = meta ?? {};
  // args.shards (below) is the SINGLE live copy of the shard/file split — the workflow reads that and
  // derives the flat file list from it, and never reads plan.shards. Embedding `shards` + `files` in
  // the plan too duplicated one long path per changed file ~3× into the args blob the orchestrator
  // model must EMIT verbatim into the Workflow call (and again into the returned payload it writes for
  // report.mjs); on a many-file PR that doubled the plan blob and widened the mid-response-drop window
  // for no benefit. Strip both from the embedded plan; keep only the shard COUNT (render's "Agents &
  // coverage" line needs it) and let the workflow rebuild plan.files from args.shards.
  const { shards: planShards, files: _planFiles, ...planLite } = plan ?? {};
  planLite.shardCount = Array.isArray(planShards) ? planShards.length : (plan?.shardCount ?? null);
  return {
    plan: planLite,
    bundle,
    diffPath,                                    // absolute path to the full unified diff — agents Read it, never inlined
    contextPackPath: contextPackPath ?? null,    // absolute path to the shared context pack; null when absent → reviewers fall back to Read/Grep
    contextPackStats: contextPackStats ?? null,  // WS7 S3: {sizeBytes,files,imports,callerHits,hop2,typeBoundary} from context-pack.mjs --stats-out; null when absent → report's coverage section omits the line
    diffIndex: diffIndex ?? null,                // legacy path-keyed {file: [[start,end]...]} — non-null ONLY in the slice-name-collision fallback, where the sandbox uses it as-is
    diffRanges: diffRanges ?? {},                // {sliceName: [[start,end]...]} for the sandbox's off-diff demotion; it rebuilds the path-keyed form from plan.files (no diff text needed)
    sliceDir: sliceDir ?? null,                  // absolute dir holding one <sliceName>.patch per reviewed file, so a reviewer Reads only its files' hunks; null → agents fall back to diffPath
    contextDir: contextDir ?? null,              // absolute dir holding one on-demand context FRAGMENT per file (context-pack.mjs --context-dir), named via sliceName; null → reviewers fall back to the whole pack at contextPackPath
    doctrineText: doctrineText ?? {},            // {agent: concatenated fragment text} — WS1 review doctrine, inlined into the prompt (tier >= standard only); {} → no doctrine
    historyPath: historyPath ?? null,  // S6.3 absolute path to history.json — intent + correctness packets Read it; null when absent/empty so historyBlock is a no-op (zero tokens)
    testSignal: testSignal ?? null,    // S6.4 executed-test signal (test-signal.mjs) → D5 packet; null unless --run-tests ran it
    knownFalsePositives: knownFalsePositives ?? [],   // accepted-FP digest (memory.mjs) → reviewer packets pre-generation; [] when learning is disabled/empty
    // Normally [{label, count, manifest}] — the file list lives on disk (see manifestText). Falls back
    // to the legacy inline [{label, files}] when the manifest write failed, or when a caller (tests)
    // passes none; the workflow's expandAspects accepts either shape.
    shards: shards ?? plan?.shards ?? [],
    allManifest: allManifest ?? null,   // manifest covering EVERY reviewed file — the unsharded (D3) aspect, triage + critic file lists; null → those fall back to the inline shard files
    allParts: allParts ?? null,         // absolute paths to the whole-diff bundle parts (bundleParts over reviewFiles) — D3 + intent Read these instead of the bare diff; null → fall back to the bare diffRead
    buildNotes: buildNotes ?? [],       // soft-degrade notes raised HERE (pre-Workflow) that the sandbox seeds its own `notes` with, so a silent pre-step degrade still reaches the user
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
  const ctxExists = existsSync(ctxPath);
  const contextPackPath = (ctxExists && readFileSync(ctxPath, 'utf8').trim() !== '') ? ctxPath : null;
  // An EMPTY context.txt means the pre-step ran and failed — surface it instead of silently
  // reviewing without a pack (contextPackNote).
  const buildNotes = contextPackNote(ctxExists, contextPackPath);
  // Pack size/per-section stats (WS7 S3), written alongside context.txt by context-pack.mjs
  // --stats-out. Optional like history.json/test-signal.json — readJSON already degrades a
  // missing/corrupt file to null.
  const contextPackStats = readJSON('context-stats.json', null);
  // Per-file context FRAGMENTS (parallel to sliceDir): context-pack.mjs writes one fragment per
  // reviewed file under <dir>/context (named via sliceName) when run with --context-dir. Best-
  // effort like sliceDir/contextPackPath: an absent dir (older run, or the pre-step skipped) is
  // normal, not a failure, so it degrades to null silently; an empty dir is treated the same way
  // (nothing was written). Only a THROWN fs error other than "doesn't exist" — e.g. the path
  // collides with a plain file — is a genuine build-time failure worth a note.
  let contextDir = null;
  try {
    const ctxDirPath = resolve(dir, 'context');
    contextDir = readdirSync(ctxDirPath).length ? ctxDirPath : null;
  } catch (e) {
    if (e.code !== 'ENOENT') buildNotes.push(`context fragments dir unreadable (${e.message}) — reviewers fall back to the whole context pack`);
    contextDir = null;
  }

  // Per-file diff slices (cost lever): each reviewed file's hunks go to their own slice on disk so a
  // reviewer Reads ONLY its files' hunks instead of the whole diff — the dominant input-token cost,
  // otherwise paid in full once per agent. The slice is named from the path (`sliceName`) rather than
  // a counter, so args carries the DIRECTORY once instead of one long absolute path per file; that
  // map and the path-keyed diffIndex were two full copies of the file list in the blob the
  // orchestrator must emit verbatim, and shrinking them is what keeps a large PR clear of
  // transcription drift. Both indices are derived from `plan.files` (already the capped reviewed set),
  // so the file-count ceiling still bounds them with no separate restriction step.
  //
  // A slice is written for EVERY reviewed file, including one the diff carries no textual hunks for
  // (rename, mode change, binary), so a derived path always exists and no reviewer is sent to a
  // missing file. Best-effort: the full diff still lives at diffPath, so any fs error leaves
  // sliceDir null and every agent falls back to it — never a starved reviewer.
  // Derive the reviewed file list EXACTLY as the sandbox does — buildArgs strips plan.files from the
  // embedded plan, so review-workflow.mjs rebuilds it by flattening args.shards. Both sides must agree
  // on the list, because the slice names keyed here are the ones it recomputes to read them back.
  const reviewFiles = (plan.files ?? []).length ? plan.files : (plan.shards ?? []).flatMap((s) => s.files ?? []);
  const fullIndex = buildDiffIndex(diffText);
  const collision = sliceNameCollision(reviewFiles);
  // Computed unconditionally (pure, cheap) — bundling must work even when a slice-name collision
  // disables sliceDir below, since bundle parts are keyed by array order, not by sliceName.
  const byFile = splitByFile(diffText);

  let sliceDir = null;
  let diffRanges = {};
  let diffIndex = null;
  if (collision) {
    // Refuse to derive rather than let two files share a slice: no slicing this run, and the
    // sandbox gets the legacy path-keyed index it can use directly.
    process.stderr.write(`build-args: slice-name collision (${collision}) — slicing disabled for this run\n`);
    diffIndex = Object.fromEntries(reviewFiles
      .map((f) => [normPath(f), fullIndex[normPath(f)]])
      .filter(([, ranges]) => ranges !== undefined));
  } else {
    diffRanges = rangesBySliceName(fullIndex, reviewFiles);
    try {
      const dirPath = resolve(dir, 'slices');
      mkdirSync(dirPath, { recursive: true });
      for (const f of reviewFiles) {
        const path = normPath(f);
        writeFileSync(join(dirPath, sliceName(f)),
          byFile[path] ?? `(no textual hunks for ${path} — rename, mode change, or binary)\n`);
      }
      sliceDir = dirPath;
    } catch { sliceDir = null; /* slicing is an optimization; on any fs error every agent reads the full diff */ }
  }

  // FILE LIST BY REFERENCE (see manifestText): write one manifest per shard plus an `all` manifest, so
  // args carries a label + a count + a path per SHARD instead of a repo path per FILE. Best-effort like
  // slicing — on any fs error the inline `plan.shards` file lists ride along as before, so a reviewer is
  // never left without a scope. Written AFTER slicing so column 2 points at slices that actually exist
  // (sliceDir is null on a collision or an fs error, and the manifest then carries paths only).
  //
  // MANIFESTS: written first, own try/catch. `parts` starts null on every shard entry — filled in by
  // the separate bundle-writing step below (or left null if that step fails), so a bundle failure
  // never has to touch this block's success state.
  let shardsOut = null;
  let allManifest = null;
  let written = [];
  try {
    const manifestDir = resolve(dir, 'manifests');
    mkdirSync(manifestDir, { recursive: true });
    written = (plan.shards ?? []).map((s, i) => {
      const path = join(manifestDir, manifestName(s.label, i));
      writeFileSync(path, manifestText(s.files ?? [], sliceDir));
      return { label: s.label, count: (s.files ?? []).length, manifest: path, parts: null };
    });
    const allPath = join(manifestDir, 'all.files');
    writeFileSync(allPath, manifestText(reviewFiles, sliceDir));
    allManifest = allPath;
    if (written.length) shardsOut = written;
  } catch (e) {
    buildNotes.push(`shard manifests not written (${e.message}) — file lists inlined into args instead`);
    shardsOut = null;
    allManifest = null;
    written = [];
  }

  // BUNDLE PARTS (cost lever): alongside each manifest, concatenate that shard's slice content into a
  // handful of "bundle parts" (bundleParts()) a reviewer Reads in one batch instead of one slice per
  // file. DELIBERATELY its own try/catch, separate from the manifest block above: bundles write
  // roughly 3x the bytes manifests do, making them the more likely failure point (e.g. disk space),
  // and a bundle-only failure must not discard manifests that already wrote fine — it only nulls
  // `parts`/`allParts` (uniformly, so a bundle-write failure never partially populates some shards
  // and not others), leaving `shardsOut`/`allManifest` exactly as the block above left them.
  let allParts = null;
  try {
    const bundleDir = resolve(dir, 'bundles');
    mkdirSync(bundleDir, { recursive: true });
    const writeBundle = (files, safeLabel) => bundleParts(files, byFile).map((text, pi) => {
      const path = join(bundleDir, `${safeLabel}-${pi}.txt`);
      writeFileSync(path, text);
      return path;
    });
    (plan.shards ?? []).forEach((s, i) => {
      if (!written[i]) return;   // manifest write failed above — nothing to attach bundle parts to
      const safeLabel = manifestName(s.label, i).replace(/\.files$/, '');
      written[i].parts = writeBundle(s.files ?? [], safeLabel);
    });
    allParts = writeBundle(reviewFiles, 'all');
  } catch (e) {
    buildNotes.push(`bundle parts not written (${e.message}) — reviewers fall back to per-shard manifest/slice reads`);
    allParts = null;
    written.forEach((s) => { s.parts = null; });
  }

  // ROUTED MANIFESTS/BUNDLES (dimension-scoped bundles, #9): a shard's own manifest/bundle span ALL
  // its files; some agents only need a subset (test files for test-adequacy, SQL/repo files for
  // data-store, contract files for api-compat — see routedFiles()). Computed HERE, not in the
  // sandboxed workflow: build-args.mjs is the only place that still holds each shard's real
  // `s.files` in memory before shards are stripped down to {label, count, manifest, parts} for the
  // args payload (the workflow sandbox never sees the file list — see the FILE LIST BY REFERENCE
  // note above). Self-limiting by construction: routedFiles returns the FULL list unchanged
  // whenever ANY dim an agent covers has no routing test, so correctness-reviewer (D1/D2/D12) and
  // D3/vuln-reviewer never produce a narrower subset here — nothing to hardcode. Skips a shard whose
  // own manifest failed to write above (nothing to attach a routed entry to). Own try/catch, same
  // discipline as the bundle-parts block above: a routed-write failure degrades to shards simply
  // having no `.routed[agent]` entries, never touching the manifests/bundles that already wrote fine.
  // Gated by plan.routing.enabled (default true, set by lib/plan.mjs) — an explicit `false` skips
  // this whole step, so no aspect is ever narrowed and no misleading "narrowed" note is raised.
  try {
    // Fold dims sharing an agent, same as expandAspects — an agent only gets a routed entry when
    // its WHOLE dim set is independently routable (routedFiles enforces this, not this loop).
    const agentDims = {};
    for (const [dim, agent] of Object.entries(plan.dimensionAgents ?? {})) {
      if (!agent) continue;
      (agentDims[agent] ??= []).push(dim);
    }
    // Nothing to route (disabled, or no dims/agents this run) — skip entirely, including the
    // mkdirSync calls below, so a run with no candidate routing work never raises a note over an
    // unrelated fs quirk in a directory this step would otherwise have no reason to touch.
    if (plan.routing?.enabled !== false && Object.keys(agentDims).length) {
      const manifestDir = resolve(dir, 'manifests');
      const bundleDir = resolve(dir, 'bundles');
      mkdirSync(manifestDir, { recursive: true });
      mkdirSync(bundleDir, { recursive: true });
      // Aggregate counters for the ONE summary note below (never one note per shard/agent — see
      // routingNote): how many (shard, agent) pairs actually narrowed, and to how many files total
      // vs. the full count those same pairs would otherwise have carried.
      let narrowedPairs = 0, narrowedFiles = 0, fullFiles = 0;
      (plan.shards ?? []).forEach((s, i) => {
        if (!written[i]) return;   // manifest write failed above — nothing to attach a routed entry to
        const files = s.files ?? [];
        const safeLabel = manifestName(s.label, i).replace(/\.files$/, '');
        for (const [agent, dims] of Object.entries(agentDims)) {
          const subset = routedFiles(dims, files);
          if (subset.length === files.length) continue;   // nothing narrowed for this agent — skip
          narrowedPairs++;
          narrowedFiles += subset.length;
          fullFiles += files.length;
          const safeAgent = String(agent).replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 40);
          const manifestPath = join(manifestDir, `${safeLabel}-${safeAgent}.files`);
          writeFileSync(manifestPath, manifestText(subset, sliceDir));
          const parts = bundleParts(subset, byFile).map((text, pi) => {
            const path = join(bundleDir, `${safeLabel}-${safeAgent}-${pi}.txt`);
            writeFileSync(path, text);
            return path;
          });
          (written[i].routed ??= {})[agent] = { manifest: manifestPath, parts, count: subset.length };
        }
      });
      const note = routingNote(narrowedPairs, narrowedFiles, fullFiles);
      if (note) buildNotes.push(note);
    }
  } catch (e) {
    // Partial by construction: shards already processed before the throw keep their `.routed`
    // entries (safe, over-broad, never under-covers) — only the REST get none, so "some" (not
    // "every") reviewer may fall back.
    buildNotes.push(`routed manifests not written (${e.message}) — some reviewers may fall back to full-shard scope`);
  }

  // WS1 review doctrine (inlined): the fragments are small (<=3.7KB total per agent), so their TEXT is
  // read here and inlined straight into the prompt instead of pointing the reviewer at a Read — saving
  // it a whole turn. The plugin root is this script's parent's parent (lib/build-args.mjs → <root>); no
  // env needed. Gated to tier >= standard inside doctrineMap. {} on a trivial/low change → no doctrine.
  const doctrineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents', 'doctrine');
  const doctrineText = {};
  for (const [agent, files] of Object.entries(doctrineMap(plan.tier))) {
    const texts = [];
    for (const f of files) {
      try { texts.push(readFileSync(join(doctrineDir, f), 'utf8')); }
      catch (e) { buildNotes.push(`doctrine fragment ${f} unreadable for ${agent} (${e.message}) — skipped`); }
    }
    if (texts.length) doctrineText[agent] = texts.join('\n\n---\n\n');
  }

  // Bug-history prior (history.mjs) is OPTIONAL and attached BY REFERENCE like contextPackPath: pass
  // the absolute path only when the file exists AND its parsed `history` object is non-empty
  // (history.mjs omits every history-less file, so a no-signal run still writes an empty object) —
  // else null, so an empty prior costs zero tokens and historyBlock emits no instruction.
  const historyJsonPath = resolve(dir, 'history.json');
  const historyData = readJSON('history.json', null);
  const historyPath = (existsSync(historyJsonPath) && historyData?.history && Object.keys(historyData.history).length > 0)
    ? historyJsonPath : null;

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
    diffIndex,
    diffRanges,
    sliceDir,
    contextDir,
    shards: shardsOut,          // null → buildArgs falls back to the inline plan.shards file lists
    allManifest,
    allParts,
    buildNotes,
    doctrineText,
    historyPath,                                            // OPTIONAL — null when history.mjs was skipped or found no fix history
    testSignal: readJSON('test-signal.json', null),        // OPTIONAL — null unless --run-tests ran it
    knownFalsePositives: knownFPs,
    scrutiny: readJSON('scrutiny.json', null),
    checks: readJSON('checks.json', null),
    meta: readJSON('meta.json', {}),
  });
  process.stdout.write(JSON.stringify(out) + '\n');
}
