import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload, pluginAgent, PLUGIN_NS, inDiffScope, partitionByScope, intentBrief, briefFor, CRITERIA_AGENTS, synthIntent, criticIntent, intentContext, screenPacket, selectGaps, CONSEQUENCE_DIRECTIVE, historyBlock, testSignalBlock, reviewerAddendum, DOUBLE_RUN_AGENTS, isDoubleRunAgent, dedupeFindings } from '../lib/review-orchestration.mjs';

test('expandAspects = agents × shards, dims carried as a list', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ label: 'A', files: ['a.ts'] }, { label: 'B', files: ['b.ts'] }],
  );
  assert.equal(aspects.length, 4);
  // A shard with no `manifest`/`parts` keeps the legacy inline shape; count is derived from the file list.
  assert.deepEqual(aspects[0], { dims: ['D2'], agent: 'correctness-reviewer', shardId: 'A', files: ['a.ts'], manifest: null, count: 1, parts: null });
});

test('expandAspects carries a shard manifest by reference instead of the file list', () => {
  // The by-reference shape build-args.mjs emits: no per-file paths in args, just a path + a count.
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ label: 'A', count: 12, manifest: '/s/manifests/0-A.files' }, { label: 'B', count: 3, manifest: '/s/manifests/1-B.files' }],
    { unsharded: ['D3'], allManifest: '/s/manifests/all.files' },
  );
  const a = aspects.find((x) => x.shardId === 'A');
  assert.equal(a.manifest, '/s/manifests/0-A.files');
  assert.equal(a.count, 12);
  assert.deepEqual(a.files, []);   // nothing inlined
  // the unsharded (D3) aspect gets the all-files manifest and the summed count
  const d3 = aspects.find((x) => x.dims.includes('D3'));
  assert.equal(d3.manifest, '/s/manifests/all.files');
  assert.equal(d3.count, 15);
});

test('expandAspects threads bundle parts alongside manifest/allManifest', () => {
  // Per-shard `parts` (build-args.mjs's bundleParts write) propagate to the shard's aspect...
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [
      { label: 'A', count: 1, manifest: '/s/manifests/0-A.files', files: ['a.ts'], parts: ['/s/bundles/0-A-0.txt'] },
      { label: 'B', count: 1, manifest: '/s/manifests/1-B.files', files: ['b.ts'], parts: ['/s/bundles/1-B-0.txt'] },
    ],
    { unsharded: ['D3'], allManifest: '/s/manifests/all.files', allParts: ['/s/bundles/all-0.txt', '/s/bundles/all-1.txt'] },
  );
  const a = aspects.find((x) => x.shardId === 'A' && x.agent === 'correctness-reviewer');
  assert.deepEqual(a.parts, ['/s/bundles/0-A-0.txt']);
  // ...and the unsharded (D3) aspect gets allParts instead of a shard's own parts.
  const d3 = aspects.find((x) => x.dims.includes('D3'));
  assert.deepEqual(d3.parts, ['/s/bundles/all-0.txt', '/s/bundles/all-1.txt']);
});

test('expandAspects: a shard with no `parts` (bundle-write failure) leaves it null', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer' },
    [{ label: 'A', files: ['a.ts'] }],
  );
  assert.equal(aspects[0].parts, null);
});

test('expandAspects folds dims sharing an agent into ONE aspect (no duplicate agent per dim)', () => {
  // D1/D2/D12 all map to correctness-reviewer — the old per-dim expansion spawned it 3× over the
  // same files; now it is a single aspect carrying all three dims.
  const aspects = expandAspects(
    { D1: 'correctness-reviewer', D2: 'correctness-reviewer', D12: 'correctness-reviewer', D5: 'test-adequacy-reviewer' },
    [{ label: 'all', files: ['a.ts'] }],
  );
  assert.equal(aspects.length, 2);
  const corr = aspects.find((a) => a.agent === 'correctness-reviewer');
  assert.deepEqual(corr.dims, ['D1', 'D2', 'D12']);
  assert.deepEqual(aspects.find((a) => a.agent === 'test-adequacy-reviewer').dims, ['D5']);
});

test('expandAspects collapses unsharded dims to one all-files aspect', () => {
  const shards = [{ label: 'A', files: ['a.ts'] }, { label: 'B', files: ['b.ts'] }];
  const aspects = expandAspects({ D2: 'correctness-reviewer', D3: 'vuln-reviewer' }, shards, { unsharded: ['D3'] });
  // D2 stays sharded (×2); D3 collapses to a single aspect over the union of all files
  assert.equal(aspects.length, 3);
  const d3 = aspects.filter((a) => a.dims.includes('D3'));
  assert.equal(d3.length, 1);
  assert.deepEqual(d3[0], { dims: ['D3'], agent: 'vuln-reviewer', shardId: 'all', files: ['a.ts', 'b.ts'], manifest: null, count: 2, parts: null });
  assert.equal(aspects.filter((a) => a.dims.includes('D2')).length, 2);
});

test('findingKey is line-sensitive and title-normalized', () => {
  assert.equal(findingKey({ file: 'x.ts', line: 10, title: '  SQL Injection ' }), 'x.ts:10:sql injection');
  assert.notEqual(
    findingKey({ file: 'x.ts', line: 10, title: 'bug' }),
    findingKey({ file: 'x.ts', line: 11, title: 'bug' }),
  );
});

test('cap counters stop at max', () => {
  const caps = newCaps();
  assert.equal(canSpawn(caps, 'verify:x:1', 3), true);
  recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1'); recordSpawn(caps, 'verify:x:1');
  assert.equal(canSpawn(caps, 'verify:x:1', 3), false);
  assert.equal(canSpawn(caps, 'verify:x:2', 3), true);
});

test('buildReportPayload throws without plan or agentRuns', () => {
  assert.throws(() => buildReportPayload({ agentRuns: {} }), /plan/);
  assert.throws(() => buildReportPayload({ plan: {} }), /agentRuns/);
});

test('pluginAgent namespaces bundled agents, passes built-ins through, is idempotent', () => {
  assert.equal(pluginAgent('error-handling-reviewer'), `${PLUGIN_NS}:error-handling-reviewer`);
  assert.equal(pluginAgent('finding-verifier'), `${PLUGIN_NS}:finding-verifier`);
  // built-in harness agent must NOT be namespaced — it has no plugin entry
  assert.equal(pluginAgent('general-purpose'), 'general-purpose');
  // already-namespaced and empty inputs pass through untouched
  assert.equal(pluginAgent(`${PLUGIN_NS}:vuln-reviewer`), `${PLUGIN_NS}:vuln-reviewer`);
  assert.equal(pluginAgent(''), '');
  assert.equal(pluginAgent(undefined), undefined);
});

import { readFileSync, readdirSync } from 'node:fs';
test('review-workflow.mjs declares a valid meta with 4 phases', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /export const meta = \{/);
  for (const p of ['Intent', 'Review', 'Verify', 'Synthesize']) {
    assert.ok(src.includes(`title: '${p}'`), `meta must list phase ${p}`);
  }
  // the report is rendered by the COMMAND (node report.mjs), not a workflow phase/agent
  assert.ok(!src.includes("title: 'Report'"), 'Report phase must be gone — report.mjs is run by the command');
  assert.doesNotMatch(src, /label: 'report'/, 'report executor agent must be removed — the workflow returns the payload');
  // inlined helpers must match the canonical signatures
  assert.match(src, /function expandAspects\(/);
  assert.match(src, /const findingKey =/);
  // every plugin agent dispatch must be namespaced; only built-ins stay bare
  assert.match(src, /const pluginAgent =/);
  assert.doesNotMatch(src, /agentType: '(?!general-purpose')[a-z-]+'/,
    'no bare plugin agentType literal may remain — wrap it in pluginAgent()');
  // triage-classifier and completeness-critic must be actually dispatched (not just listed in render.mjs)
  assert.match(src, /pluginAgent\('triage-classifier'\)/, 'triage-classifier must be dispatched');
  assert.match(src, /pluginAgent\('completeness-critic'\)/, 'completeness-critic must be dispatched');
  // S3: the two intent agents are merged into one intent-analyzer pass; neither original is dispatched
  assert.match(src, /pluginAgent\('intent-analyzer'\)/, 'intent-analyzer must be dispatched');
  assert.doesNotMatch(src, /pluginAgent\('intent-harvester'\)/, 'intent-harvester dispatch must be removed (merged into intent-analyzer)');
  assert.doesNotMatch(src, /pluginAgent\('business-logic-analyzer'\)/, 'business-logic-analyzer dispatch must be removed (merged into intent-analyzer)');
  // COST LEVER (model pins): intent, synth, and gap re-dispatch are reviewer/analysis passes, not
  // orchestration — a Workflow agent with no model opt inherits the SESSION model, so from an opus
  // session they silently ran on opus. Pin them to sonnet so cost is deterministic + matches frontmatter.
  assert.match(src, /model: 'sonnet', label: 'intent'/, 'intent-analyzer must be pinned to sonnet (+ labelled)');
  assert.match(src, /pluginAgent\('review-synthesizer'\), model: 'sonnet'/, 'review-synthesizer must be pinned to sonnet');
  assert.match(src, /pluginAgent\(g\.dispatch\.agent\), model: 'sonnet'/, 'gap re-dispatch reviewers must be pinned to sonnet');
  // COST LEVER (slicing): reviewers/verifiers Read per-file diff slices via diffReadFor, not the whole diff.
  assert.match(src, /const diffReadFor = /, 'the per-file slice diff-read helper must exist');
  assert.match(src, /diffReadFor\(a\.files\)/, 'reviewers must read the slices for their files');
  // COST LEVER (bundle parts, Task 1): scopeFor prefers a shard's pre-concatenated bundle parts —
  // a handful of parallel Reads — over the per-slice manifest branch when parts are present.
  assert.match(src, /const parts = a\.parts \?\? \[\];/, 'scopeFor must check a.parts before the manifest branch');
  assert.match(src, /Read ALL of them now, /, 'scopeFor must instruct the reviewer to Read every bundle part');
  assert.match(src, /in one batch of parallel Read calls/, 'scopeFor must call out that parallel Reads cost one turn');
  assert.match(src, /=== FILE: <path> ===/, 'scopeFor must describe the bundle part boundary header');
  // COST LEVER (bundle parts, Task 2): D3 (unsharded, cross-file taint) also prefers allParts over
  // the bare full-diff Read, falling back to diffRead only when allParts is empty/null.
  assert.match(src, /const allBundleParts = allParts \?\? \[\];/, 'scopeFor must check allParts for the D3 branch before falling back to the bare diff');
  assert.match(src, /Review EVERY changed file across those parts for dimension\(s\) \$\{dimList\}\./, 'D3 with allParts must still review every changed file, across the bundle parts');
  // COST LEVER (bundle parts, Task 4): intent-analyzer (global, single pass, no per-file slice)
  // also prefers allParts over the bare full-diff Read, falling back to diffRead + the
  // lockfile-churn caveat only when allParts is empty/null — same fallback shape as D3.
  assert.match(src, /const intentParts = allParts \?\? \[\];/, 'intent must check allParts before falling back to the bare diff');
  assert.match(src, /const intentDiffRead = intentParts\.length/, 'intent must branch its diff-read instruction on intentParts');
  assert.match(src, /: `\$\{diffRead\} \(ignore lockfile\/build-artifact\/vendored churn/, 'intent must fall back to diffRead with the lockfile-churn caveat when allParts is empty');
  assert.match(src, /`\$\{intentDiffRead\}\\n\\nIn ORDER:/, 'intent-analyzer prompt must use intentDiffRead');
  // intent's read budget is capped once it has full bundle coverage (no maxTurns option exists on
  // the Workflow harness's agent() call — the cap must be a prompt-text instruction).
  assert.match(src, /cap any FURTHER Read\/Grep\/Bash calls at 3/, 'intent must cap further lookups once it has full bundle coverage');
  // COST LEVER (sonnet-first verify): first-pass refuter groups run on modelFirst (sonnet), opus only for a critical group + the reverify guard.
  assert.match(src, /const firstModel = plan\.verify\?\.modelFirst/, 'batched verify must be sonnet-first via modelFirst');
  assert.match(src, /function intentBrief\(/, 'intentBrief must be inlined (canonical: lib/review-orchestration.mjs)');
  // triage-classifier is skipped for the trivial tier only (launched in parallel with intent otherwise)
  assert.match(src, /plan\.tier === 'trivial' \? Promise\.resolve\(null\)/, 'triage-classifier must be guarded for the trivial tier');
  // completeness-critic gates on the exhaustive discovery flag
  assert.match(src, /plan\.discovery\?\.completenessCritic/);
  // resolve is inlined (pure), not dispatched as a general-purpose executor agent
  assert.doesNotMatch(src, /label: 'resolve'/, 'resolve must be inlined, not dispatched');
  assert.match(src, /function resolveVerification\(/, 'resolveVerification must be inlined');
  assert.match(src, /function partition\(/, 'partition must be inlined');
  // verification is bounded by selectForVerification (verify the unsure, not every finding)
  assert.match(src, /selectForVerification\(findings/, 'verify must gate through selectForVerification');
  // plan.verify is consumed AS RESOLVED (camelCase, from plan.mjs) — merged over defaults, not
  // re-resolved through cleanVerify (which maps only snake_case and would revert custom config).
  assert.match(src, /\{ \.\.\.DEFAULT_VERIFY, \.\.\.\(plan\.verify \?\? \{\}\) \}/, 'policy must merge the resolved plan.verify');
  assert.doesNotMatch(src, /function cleanVerify\(/, 'cleanVerify must NOT be re-inlined — config is resolved once in plan.mjs');
  // BATCHED verify (≤ maxVerifierAgents opus groups + 1 reverify guard): findings are grouped by
  // (lens, file) via the inlined groupForVerification, refuted per group, then a reverify guard runs.
  assert.match(src, /function groupForVerification\(/, 'groupForVerification must be inlined (canonical: lib/verify.mjs)');
  assert.match(src, /const VERDICTS_SCHEMA =/, 'batched verifiers must return a verdicts array');
  assert.match(src, /reverifyGuard/, 'the +1 reverify false-negative guard must run');
  assert.match(src, /plan\.verify\?\.verifyModel/, 'verify must use the resolved verify model (opus)');
  assert.match(src, /groupForVerification\(tagged, budget\)/, 'verify must cap agents via the group budget');
  // the retired per-finding cheap→strong escalation must be gone from the workflow (superseded by batched all-opus)
  assert.doesNotMatch(src, /function verifyWithEscalation\(/, 'per-finding escalation is retired — batched verify supersedes it');
  assert.doesNotMatch(src, /function firstPassModel\(/, 'per-finding firstPassModel is retired from the workflow');
  // S2 (args-by-reference): the shared context pack arrives as a PATH, turned into a Read-it-first
  // instruction prepended to every reviewer packet; the diff is likewise passed by path.
  assert.match(src, /const \{ plan, bundle, diffPath, contextPackPath, diffIndex,/, 'diffPath/contextPackPath/diffIndex must be destructured from args');
  assert.match(src, /const packBlock =/, 'the context pack path must be turned into a prepend block');
  assert.match(src, /\$\{packBlock\}/, 'packBlock must be prepended to the reviewer packet(s)');
  // ARGS-BY-REFERENCE: the diff is NEVER inlined — agents Read it from diffPath. The old in-sandbox
  // diff-trim helpers must be gone (their return re-inflated args past the Workflow inline limit).
  assert.match(src, /const diffRead = `Read the diff at \$\{diffPath\}/, 'the workflow must hand agents the diff PATH to Read, not inlined text');
  assert.doesNotMatch(src, /function filterDiff\(/, 'filterDiff must NOT be inlined — agents focus by file list, not pre-sliced diff text');
  assert.doesNotMatch(src, /function stripNoise\(/, 'stripNoise must NOT be inlined — the intent agent is told to ignore churn while reading diffPath');
  assert.match(src, /unsharded: \['D3'\]/, 'D3 (security) stays one aspect over all files for cross-file taint');
  // the dead pr-comment-author dispatch is gone (comments.mjs does the real posting)
  assert.doesNotMatch(src, /pluginAgent\('pr-comment-author'\)/, 'pr-comment-author dispatch must be removed');
});

test('args-by-reference: the workflow keeps the diff out of args + its own body', async () => {
  const wf = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  const ba = readFileSync(new URL('../lib/build-args.mjs', import.meta.url), 'utf8');
  // build-args emits the diff PATH + a precomputed diffIndex, never the diff text.
  assert.match(ba, /diffPath,/, 'build-args must emit diffPath');
  assert.match(ba, /fullIndex = buildDiffIndex\(diffText\)/, 'build-args must precompute the changed-line index from diff.txt');
  assert.match(ba, /diffRanges = rangesBySliceName\(fullIndex, reviewFiles\)/, 'build-args must key the ranges by slice name so args carries the file list once, not three times');
  assert.doesNotMatch(ba, /sliceIndex\[/, 'the path\u2192slice-path map is retired \u2014 args carries sliceDir and the name is derived');
  assert.doesNotMatch(ba, /\bdiff,\n/, 'build-args must not carry the diff TEXT in args');
  // the sandbox consumes the passed diffIndex for off-diff demotion (it can no longer build one).
  assert.match(wf, /partitionByScope\(synth\.findings \?\? \[\], scopeIndex/, 'the workflow must demote using the index it rebuilt from diffRanges');
  assert.match(wf, /const scopeIndex = diffIndex \?\?/, 'the sandbox must rebuild the path-keyed index from diffRanges, falling back to a passed diffIndex');
  assert.match(wf, /sliceName\)\.filter\(\(n\) => reviewedSlices\.has\(n\)\)/, 'the reviewed set must be recognized by slice name (diffRanges keys), not a carried path list');
  assert.match(wf, /\$\{sliceDir\}\/\$\{n\}/, 'slice paths must be DERIVED from sliceDir + sliceName, not read from a map');
  // FILE LIST BY REFERENCE: args carries per-shard manifest PATHS, so neither side inlines a path per file.
  assert.match(ba, /writeFileSync\(path, manifestText\(s\.files \?\? \[\], sliceDir\)\)/, 'build-args must write one manifest per shard');
  assert.match(wf, /const scopeFor = \(a, dimList\) =>/, 'the sandbox must resolve a reviewer scope from either a manifest or an inline list');
  assert.doesNotMatch(wf, /plan\.files = /, 'the sandbox must NOT rebuild plan.files — nothing needs it, and it would ride back out in the payload');
  assert.doesNotMatch(wf, /function buildDiffIndex\(/, 'buildDiffIndex must live in build-args (via trim-diff), not the sandbox');
  // normPath is still needed inline (inDiffScope keys on it) — now a function declaration mirroring
  // trim-diff.mjs's unquote-then-strip-prefix form, not the old bare arrow; sectionPath went with filterDiff.
  assert.match(wf, /function normPath\(p\)/);
  assert.match(wf, /function unquoteGitPath\(s\)/, 'unquoteGitPath must be inlined alongside normPath');
  assert.doesNotMatch(wf, /function sectionPath\(/, 'sectionPath left with filterDiff — nothing in the sandbox parses diff text now');
});

// --- intent brief (S3: merged intent-analyzer) ---
test('intentBrief keeps criteria + mismatches + only scrutiny-flagged groups', () => {
  const intent = {
    summary: 's', statedIntent: 'stated', derivedIntent: 'derived',
    acceptanceCriteria: [{ id: 'AC1', text: 'r' }],
    mismatches: [{ kind: 'missing', text: 'm' }],
    expectedTests: ['t'], outOfScope: ['o'], extraIntents: ['e'],
    model: 'domain', assumptions: [{ text: 'a' }], openQuestions: [{ question: 'q' }],
    groups: [
      { label: 'primary', kind: 'primary', scrutinize: false },
      { label: 'drive-by', kind: 'extra', scrutinize: true, files: ['src/main/java/deep/pkg/Foo.java'] },
    ],
  };
  const brief = intentBrief(intent);
  // the reviewer brief must carry acceptanceCriteria + mismatches (S3 acceptance)
  assert.deepEqual(brief.acceptanceCriteria, intent.acceptanceCriteria);
  assert.deepEqual(brief.mismatches, intent.mismatches);
  // only the scrutiny-flagged group survives
  assert.equal(brief.scrutinize.length, 1);
  assert.equal(brief.scrutinize[0].label, 'drive-by');
  // the bulky prose + domain-logic fields are NOT in the compact brief (reserved for deep consumers)
  assert.equal(brief.statedIntent, undefined);
  assert.equal(brief.expectedTests, undefined);
  assert.equal(brief.model, undefined);
  assert.equal(brief.openQuestions, undefined);
});

test('intentBrief reduces scrutinize-group files to basenames (the reviewer holds full paths in its manifest)', () => {
  const brief = intentBrief({
    groups: [{ label: 'x', scrutinize: true, files: ['a/b/c/Deep.java', 'Top.java'] }],
  });
  assert.deepEqual(brief.scrutinize[0].files, ['Deep.java', 'Top.java']);
  // the rest of the group is untouched — only `files` is rewritten
  assert.equal(brief.scrutinize[0].label, 'x');
  // a group with no files array is passed through as-is (never gains an empty `files` key)
  const noFiles = intentBrief({ groups: [{ label: 'y', scrutinize: true }] });
  assert.ok(!('files' in noFiles.scrutinize[0]));
});

test('intentBrief tolerates a schema miss (non-object) by passing it through', () => {
  assert.equal(intentBrief('raw prose'), 'raw prose');
  assert.equal(intentBrief(null), null);
  // a groups-less object still yields an empty scrutinize list, never a throw
  assert.deepEqual(intentBrief({ acceptanceCriteria: [] }).scrutinize, []);
});

test('inlined intentBrief stays in sync with the canonical lib/review-orchestration.mjs', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  // the inlined copy must reproduce the canonical scrutinize filter + object-guard
  assert.match(src, /function intentBrief\(intent\)/);
  assert.match(src, /\(intent\.groups \?\? \[\]\)\.filter\(\(g\) => g\?\.scrutinize\)/);
  assert.match(src, /typeof intent !== 'object'/);
});

// --- per-consumer intent projections: only what each agent's contract actually reads ---

test('briefFor gives the full brief to criteria-consuming reviewers and the summary alone to the rest', () => {
  const brief = { summary: 's', acceptanceCriteria: [{ id: 'AC1' }], mismatches: [{ kind: 'missing' }], scrutinize: [{ label: 'g' }] };
  for (const a of ['correctness-reviewer', 'test-adequacy-reviewer']) {
    assert.deepEqual(briefFor(a, brief), brief, `${a} must keep the criteria it traces`);
  }
  for (const a of ['vuln-reviewer', 'data-store-reviewer', 'concurrency-reviewer', 'simplification-reviewer']) {
    assert.deepEqual(briefFor(a, brief), { summary: 's' }, `${a} does not act on criteria`);
  }
  // schema-miss passthrough, same contract as intentBrief
  assert.equal(briefFor('vuln-reviewer', 'raw prose'), 'raw prose');
  assert.equal(briefFor('vuln-reviewer', null), null);
});

test('CRITERIA_AGENTS matches the agent files that actually act on acceptance criteria', () => {
  // the guard against drift: an agent still told it receives criteria must be in the set, and an
  // agent in the set must still be a real bundled reviewer.
  const dir = new URL('../agents/', import.meta.url);
  for (const agent of CRITERIA_AGENTS) {
    const md = readFileSync(new URL(`${agent}.md`, dir), 'utf8');
    assert.match(md, /acceptance criteri/i, `${agent} is in CRITERIA_AGENTS but never mentions criteria`);
  }
  for (const f of readdirSync(dir).filter((x) => x.endsWith('-reviewer.md'))) {
    const agent = f.replace(/\.md$/, '');
    if (CRITERIA_AGENTS.has(agent)) continue;
    const md = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(md, /an intent summary \+ acceptance criteria/,
      `${agent} no longer receives criteria (briefFor sends summary only) — its input-packet line must not claim it does`);
  }
});

test('synthIntent keeps only the fields review-synthesizer.md reads, and never re-sends openQuestions', () => {
  const intent = {
    summary: 's', acceptanceCriteria: [{ id: 'AC1' }], mismatches: [{ kind: 'missing' }],
    openQuestions: [{ question: 'q' }], model: 'domain', assumptions: [{ text: 'a' }],
    businessRisks: [{ text: 'r' }], groups: [{ label: 'g' }], statedIntent: 'x', derivedIntent: 'y',
    expectedTests: ['t'], outOfScope: ['o'], extraIntents: ['e'],
  };
  assert.deepEqual(synthIntent(intent), { summary: 's', acceptanceCriteria: [{ id: 'AC1' }], mismatches: [{ kind: 'missing' }] });
  // openQuestions travels as its own labelled prompt term — including it here would double-send it
  assert.equal(synthIntent(intent).openQuestions, undefined);
  assert.equal(synthIntent(null), null);
});

test('criticIntent keeps every gap-kind-bearing field but drops the per-group file lists', () => {
  const intent = {
    summary: 's', acceptanceCriteria: [{ id: 'AC1' }], mismatches: [{ kind: 'missing' }],
    expectedTests: ['t'], businessRisks: [{ text: 'r' }], openQuestions: [{ question: 'q' }],
    groups: [{ label: 'g', intent: 'i', scrutinize: true, files: ['a/b/C.java'] }],
    model: 'domain', assumptions: [{ text: 'a' }], statedIntent: 'x', derivedIntent: 'y',
    outOfScope: ['o'], extraIntents: ['e'],
  };
  const out = criticIntent(intent);
  // each of these backs a gap kind the critic may emit
  assert.deepEqual(out.acceptanceCriteria, intent.acceptanceCriteria);
  assert.deepEqual(out.expectedTests, intent.expectedTests);
  assert.deepEqual(out.businessRisks, intent.businessRisks);
  assert.deepEqual(out.openQuestions, intent.openQuestions);
  // clustering survives; the paths do not (the exhaustive critic gets the full diff + manifest)
  assert.deepEqual(out.groups, [{ label: 'g', intent: 'i', scrutinize: true }]);
  // no gap kind consumes these
  for (const k of ['model', 'assumptions', 'statedIntent', 'derivedIntent', 'outOfScope', 'extraIntents']) {
    assert.equal(out[k], undefined, `criticIntent must drop ${k}`);
  }
  assert.deepEqual(criticIntent({}).groups, []);
  assert.equal(criticIntent(null), null);
});

test('the workflow routes each intent consumer through its own projection', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  // reviewers + gap re-dispatch go through briefFor, never the raw brief
  assert.match(src, /JSON\.stringify\(briefFor\(a\.agent, brief\)\)/);
  assert.match(src, /JSON\.stringify\(briefFor\(g\.dispatch\.agent, brief\)\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(brief\)/, 'the un-narrowed brief must never be sent to an agent');
  // synth + the exhaustive critic get their own slices, not the full intent object
  assert.match(src, /JSON\.stringify\(synthIntent\(intent\)\)/);
  assert.match(src, /JSON\.stringify\(criticIntent\(intent\)\)/);
  assert.doesNotMatch(src, /JSON\.stringify\(intent\)/, 'the full intent object must never be inlined into a prompt');
  // ...but the cheap SCREEN still receives the RAW intent: it has no diff and no file list, so
  // harvester.groups[].files is its only source of re-dispatch targets.
  assert.match(src, /screenPacket\(\{ plan, findings: allFindings, intent, extraDims: triageExtraDims \}\)/);
});

// --- intentContext: the intent-analyzer's REAL PR/comment/commit/ticket digest ---
test('intentContext renders PR + comments + commits + tickets, each capped', () => {
  const bundle = {
    pr: { title: 'Add auth', body: 'Implements OAuth per RFC-123' },
    existingComments: [{ author: 'alice', body: 'looks risky' }, { author: 'bob', body: 'lgtm' }],
    commits: [{ subject: 'wip' }, { subject: 'fix: token refresh' }],
    tickets: [{ tracker: 'jira', key: 'AB-1', title: 'OAuth support', description: 'Users need SSO' }],
  };
  const ctx = intentContext(bundle);
  assert.match(ctx, /PR: Add auth/);
  assert.match(ctx, /Implements OAuth per RFC-123/);
  assert.match(ctx, /alice: looks risky/);
  assert.match(ctx, /bob: lgtm/);
  assert.match(ctx, /fix: token refresh/);
  assert.match(ctx, /jira AB-1: OAuth support — Users need SSO/);
});

test('intentContext caps each section (comments ≤10, commits ≤20) and long text', () => {
  const manyComments = Array.from({ length: 15 }, (_, i) => ({ author: `u${i}`, body: `c${i}` }));
  const manyCommits = Array.from({ length: 30 }, (_, i) => ({ subject: `s${i}` }));
  const ctx = intentContext({ existingComments: manyComments, commits: manyCommits });
  assert.equal((ctx.match(/^- u\d+:/gm) ?? []).length, 10);
  assert.equal((ctx.match(/^- s\d+$/gm) ?? []).length, 20);
  const longBody = 'x'.repeat(5000);
  const capped = intentContext({ pr: { title: 't', body: longBody } });
  assert.ok(capped.length < longBody.length, 'PR body must be capped, not passed through whole');
});

test('intentContext degrades to an empty string on an empty/absent bundle, never throws', () => {
  assert.equal(intentContext(), '');
  assert.equal(intentContext({}), '');
  assert.equal(intentContext(null), '');
});

test('inlined intentContext stays in sync with the canonical lib/review-orchestration.mjs', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /function intentContext\(bundle = \{\}, \{ maxTotal = 12000 \} = \{\}\)/);
  assert.match(src, /function truncate\(s, n\)/);
  assert.match(src, /intentContext: intentContext\(bundle\)/, 'the intent packet must carry the real digest, not just bundle.summary');
});

test('buildReportPayload assembles all fields', () => {
  const p = buildReportPayload({
    plan: { tier: 'high', gate: { block_on: ['critical'] }, learning: { store: 's' }, range: 'a..b' },
    agentRuns: { 'vuln-reviewer': 2 },
    findings: [{ severity: 'minor', file: 'a', title: 't' }],
    criteria: [{ id: 'AC1', text: 'r', covered: true }],
    strengths: ['s'], summary: 'sum', needsHuman: ['q'], skipped: ['x'],
    context: { pr: null }, verifySummary: { kept: 1 },
    startedAt: '2026-06-22T00:00:00Z', prNumber: 7, checkout: null, commentMode: true,
  });
  assert.equal(p.tier, 'high');
  assert.equal(p.plan.tier, 'high');
  assert.equal(p.agentRuns['vuln-reviewer'], 2);
  assert.equal(p.gate.block_on[0], 'critical');
  assert.equal(p.commentMode, true);
  assert.equal(p.learningStore, 's');
  assert.equal(p.range, 'a..b');
});

// --- diff-scope demotion (S1.1) ---
const SCOPE_IDX = { 'src/foo.js': [[10, 13], [41, 42]], 'del.js': [] };

test('inDiffScope: inside a hunk and within slack are kept; clearly-outside is demoted', () => {
  assert.equal(inDiffScope({ file: 'src/foo.js', line: 11 }, SCOPE_IDX, 3), true);  // inside [10,13]
  assert.equal(inDiffScope({ file: 'src/foo.js', line: 16 }, SCOPE_IDX, 3), true);  // 13 + slack 3
  assert.equal(inDiffScope({ file: 'src/foo.js', line: 25 }, SCOPE_IDX, 3), false); // outside both ranges
});

test('inDiffScope: demotion keys on the FILE — never on a missing line', () => {
  assert.equal(inDiffScope({ file: 'other.js', line: 5 }, SCOPE_IDX), false);  // unchanged file → demote
  assert.equal(inDiffScope({ file: 'src/foo.js' }, SCOPE_IDX), true);          // changed file, no line → KEEP
  assert.equal(inDiffScope({ file: 'src/foo.js', line: null }, SCOPE_IDX), true);
  assert.equal(inDiffScope({ file: 'del.js', line: 999 }, SCOPE_IDX), true);   // changed, no new-side lines (deletion) → KEEP
  assert.equal(inDiffScope({ line: 5 }, SCOPE_IDX), true);                     // no file → keep (gate-safe)
});

test('partitionByScope splits gate-affecting vs advisory findings', () => {
  const findings = [
    { file: 'src/foo.js', line: 11, title: 'in' },
    { file: 'other.js', line: 5, title: 'out' },
    { file: 'src/foo.js', title: 'lineless-kept' },
  ];
  const { inScope, outOfDiff } = partitionByScope(findings, SCOPE_IDX, 3);
  assert.deepEqual(inScope.map((f) => f.title), ['in', 'lineless-kept']);
  assert.deepEqual(outOfDiff.map((f) => f.title), ['out']);
});

test('buildReportPayload carries outOfDiff (defaults to [])', () => {
  const base = { plan: { tier: 'high', gate: {} }, agentRuns: {} };
  assert.deepEqual(buildReportPayload(base).outOfDiff, []);
  assert.deepEqual(buildReportPayload({ ...base, outOfDiff: [{ title: 'x' }] }).outOfDiff, [{ title: 'x' }]);
});

test('buildReportPayload carries testSignal (defaults to null)', () => {
  const base = { plan: { tier: 'high', gate: {} }, agentRuns: {} };
  assert.equal(buildReportPayload(base).testSignal, null);
  const ts = { ran: true, passed: false, failing: ['t1'] };
  assert.deepEqual(buildReportPayload({ ...base, testSignal: ts }).testSignal, ts);
});

// --- S6.1: completeness screen packet + gap cap ---
test('screenPacket carries coverage metadata (dims + finding titles + raw harvester) and NO diff', () => {
  const plan = { dimensions: ['D1', 'D2', 'D5'] };
  const intent = { acceptanceCriteria: [{ id: 'AC1', text: 'admins only' }] };
  const findings = [{ title: 'null deref', dimension: 'D2' }, { dimension: 'D5' /* no title */ }];
  const p = screenPacket({ plan, findings, intent, extraDims: ['D3'] });
  assert.equal(p.mode, 'screen');
  assert.deepEqual(p.dimensionsRan, ['D1', 'D2', 'D5', 'D3']);        // plan dims + triage extras
  assert.deepEqual(p.findingTitles, [{ title: 'null deref', dimension: 'D2' }]); // title-less dropped
  assert.deepEqual(p.harvester, intent);                              // raw harvester, not a coverage matrix
  assert.ok(!('diff' in p), 'the screen must NOT carry a diff (cannot claim untraced-taint)');
});

test('selectGaps keeps only dispatchable gaps and caps the count (6 exhaustive / 2 screen)', () => {
  const gaps = [
    { kind: 'missing-dimension', dispatch: { agent: 'vuln-reviewer' } },
    { kind: 'uncovered-criterion', dispatch: {} },              // no agent → dropped
    { kind: 'uncovered-criterion', dispatch: { agent: 'test-adequacy-reviewer' } },
    { kind: 'missing-test', dispatch: { agent: 'test-adequacy-reviewer' } },
  ];
  assert.equal(selectGaps(gaps, 6).length, 3);                  // all dispatchable ones
  assert.equal(selectGaps(gaps, 2).length, 2);                  // screen cap
  assert.deepEqual(selectGaps([], 6), []);
  assert.deepEqual(selectGaps(undefined, 2), []);
});

test('selectGaps drops gaps naming a non-bundled agent when a whitelist is supplied', () => {
  // The completeness-critic LLM can hallucinate a plausible-but-nonexistent agent (e.g.
  // "intent-verifier" ~ the real "intent-analyzer"); re-dispatching it throws "agent type not
  // found". The whitelist (the real *-reviewer set) filters invented names out BEFORE dispatch.
  const valid = ['vuln-reviewer', 'test-adequacy-reviewer', 'correctness-reviewer'];
  const gaps = [
    { kind: 'uncovered-criterion', dispatch: { agent: 'intent-verifier' } },    // invented → dropped
    { kind: 'missing-dimension', dispatch: { agent: 'vuln-reviewer' } },        // real → kept
    { kind: 'missing-test', dispatch: { agent: 'test-adequacy-reviewer' } },    // real → kept
  ];
  const kept = selectGaps(gaps, 6, valid);
  assert.deepEqual(kept.map((g) => g.dispatch.agent), ['vuln-reviewer', 'test-adequacy-reviewer']);
  assert.equal(selectGaps(gaps, 6).length, 3);   // no whitelist arg → back-compat, no name check
  assert.equal(selectGaps(gaps, 6, null).length, 3); // explicit null → treated as "no whitelist"
});

// --- S6.2/S6.3/S6.4: per-reviewer packet addenda ---
test('CONSEQUENCE_DIRECTIVE names the caller list + demands a needs-human question when unsure', () => {
  assert.match(CONSEQUENCE_DIRECTIVE, /caller list/i);
  assert.match(CONSEQUENCE_DIRECTIVE, /needs-human question/i);
  assert.match(CONSEQUENCE_DIRECTIVE, /uncertain:true/);
});

test('historyBlock renders a Read instruction for a path, else empty for a null/absent path', () => {
  assert.equal(historyBlock(null), '');
  assert.equal(historyBlock(undefined), '');
  assert.equal(historyBlock(''), '');
  const b = historyBlock('/scratch/history.json');
  assert.match(b, /PRIOR BUG HISTORY/);
  assert.match(b, /Read \/scratch\/history\.json/);             // args-by-reference: a Read instruction, not the data
  assert.match(b, /history.*<file>.*notes/);                    // documents the { history: {file: [subjects]}, notes: [] } shape
});

test('testSignalBlock reflects pass/fail with failing names, empty when not run', () => {
  assert.equal(testSignalBlock(null), '');
  assert.equal(testSignalBlock({ ran: false }), '');
  assert.match(testSignalBlock({ ran: true, passed: true }), /PASSED/);
  const fail = testSignalBlock({ ran: true, passed: false, failing: ['auth spec', 'cap spec'] });
  assert.match(fail, /FAILED/);
  assert.match(fail, /Failing: auth spec, cap spec\./);
});

test('reviewerAddendum routes each extra to the right reviewer, others get nothing', () => {
  const historyPath = '/scratch/history.json';
  const testSignal = { ran: true, passed: false, failing: ['t1'] };
  const corr = reviewerAddendum('correctness-reviewer', { historyPath, testSignal });
  assert.match(corr, /CROSS-FILE CONSEQUENCE/);       // S6.2
  assert.match(corr, /PRIOR BUG HISTORY/);            // S6.3
  assert.doesNotMatch(corr, /EXECUTED TEST SIGNAL/);  // D5-only, not correctness
  const d5 = reviewerAddendum('test-adequacy-reviewer', { historyPath, testSignal });
  assert.match(d5, /EXECUTED TEST SIGNAL/);           // S6.4
  assert.doesNotMatch(d5, /CROSS-FILE CONSEQUENCE/);
  assert.doesNotMatch(d5, /PRIOR BUG HISTORY/);       // history rides correctness, not D5
  assert.equal(reviewerAddendum('vuln-reviewer', { historyPath, testSignal }), ''); // everyone else: nothing
  assert.equal(reviewerAddendum('correctness-reviewer', {}), '\n' + CONSEQUENCE_DIRECTIVE); // directive always, history only when present
});

// --- S7.1: exhaustive double-run union/dedupe ---
test('isDoubleRunAgent flags only the correctness + vuln reviewers', () => {
  assert.equal(isDoubleRunAgent('correctness-reviewer'), true);
  assert.equal(isDoubleRunAgent('vuln-reviewer'), true);
  assert.equal(isDoubleRunAgent('test-adequacy-reviewer'), false);
  assert.equal(isDoubleRunAgent('finding-verifier'), false);
  assert.equal(isDoubleRunAgent(undefined), false);
  assert.deepEqual([...DOUBLE_RUN_AGENTS].sort(), ['correctness-reviewer', 'vuln-reviewer']);
});

test('dedupeFindings unions two passes by findingKey, first occurrence wins (deterministic)', () => {
  const pass1 = [
    { file: 'a.js', line: 3, title: 'SQL injection', confidence: 90 },
    { file: 'b.js', line: 7, title: 'null deref' },
  ];
  const pass2 = [
    { file: 'a.js', line: 3, title: '  sql injection ', confidence: 50 }, // same key (line-sensitive + title-normalized)
    { file: 'c.js', line: 1, title: 'missing check' },                    // unique to pass 2
  ];
  const merged = dedupeFindings([...pass1, ...pass2]);
  assert.equal(merged.length, 3);                       // 4 findings, one duplicate collapsed
  const dup = merged.find((f) => f.file === 'a.js');
  assert.equal(dup.confidence, 90);                     // first occurrence (pass 1) wins the tie
  assert.ok(merged.some((f) => f.file === 'b.js'));     // union keeps pass-1-only
  assert.ok(merged.some((f) => f.file === 'c.js'));     // union keeps pass-2-only
  // a same-title finding at a DIFFERENT line is distinct (line-sensitive key), never merged
  assert.equal(dedupeFindings([{ file: 'x', line: 1, title: 't' }, { file: 'x', line: 2, title: 't' }]).length, 2);
});

test('dedupeFindings is a no-op on an empty/single/absent list', () => {
  assert.deepEqual(dedupeFindings([]), []);
  assert.deepEqual(dedupeFindings(), []);
  const one = [{ file: 'x', line: 1, title: 't' }];
  assert.deepEqual(dedupeFindings(one), one);
});

// --- S7: inlined copies + double-run wiring stay in sync with the canonical helpers ---
test('inlined S7 helpers + double-run wiring stay in sync with lib/review-orchestration.mjs', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /const DOUBLE_RUN_AGENTS = new Set\(\['correctness-reviewer', 'vuln-reviewer'\]\)/, 'DOUBLE_RUN_AGENTS must be inlined');
  assert.match(src, /const isDoubleRunAgent =/, 'isDoubleRunAgent must be inlined');
  assert.match(src, /function dedupeFindings\(/, 'dedupeFindings must be inlined');
  // stage 1 gates the double-run on the exhaustive discovery flag and dedupes BEFORE Verify
  assert.match(src, /plan\.discovery\?\.doubleRun/, 'the double-run must gate on discovery.doubleRun');
  assert.match(src, /doubleRun && isDoubleRunAgent\(a\.agent\)/, 'only correctness + vuln reviewers double-run');
  assert.match(src, /dedupeFindings\(passes\.flatMap/, 'the two passes must be unioned + deduped before Verify');
  // S7.2: the retired machinery must not resurface as a dispatched pass
  assert.doesNotMatch(src, /generativeVerify/, 'generativeVerify must be gone');
  assert.doesNotMatch(src, /loopUntilDry/, 'loopUntilDry must be gone');
});

// --- S6: inlined copies stay in sync with the canonical helpers ---
test('inlined S6 helpers stay in sync with lib/review-orchestration.mjs', () => {
  const src = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  assert.match(src, /function screenPacket\(/, 'screenPacket must be inlined');
  assert.match(src, /function selectGaps\(/, 'selectGaps must be inlined');
  assert.match(src, /const CONSEQUENCE_DIRECTIVE =/, 'consequence directive must be inlined');
  assert.match(src, /function historyBlock\(/, 'historyBlock must be inlined');
  assert.match(src, /function testSignalBlock\(/, 'testSignalBlock must be inlined');
  assert.match(src, /function reviewerAddendum\(/, 'reviewerAddendum must be inlined');
  // the high-tier screen gates on the discovery flag and reuses completeness-critic on sonnet
  assert.match(src, /plan\.discovery\?\.completenessScreen/, 'the screen must gate on completenessScreen');
  assert.match(src, /label: 'completeness-screen'/, 'the screen dispatch must be labelled');
  assert.match(src, /reviewerAddendum\(a\.agent, \{ historyPath, testSignal \}\)/, 'reviewers must get the S6 addendum');
  assert.match(src, /const \{ plan, bundle, diffPath, contextPackPath, diffIndex, historyPath, testSignal,/, 'historyPath + testSignal must be destructured from args');
  assert.match(src, /checkout, diffRanges, sliceDir,/, 'diffRanges + sliceDir must be destructured from args');
});

// --- comprehensive textual sync guard ---
// The regex-based checks above only confirm a signature or a substring is PRESENT — they are blind
// to a private helper drifting internally (e.g. isOnRiskPath's null-guard/toLowerCase placement used
// to differ from lib/verify.mjs with no test catching it). This extracts each inlined function's FULL
// body from both the canonical source and review-workflow.mjs (by counting braces from the matching
// parameter-list close to the end of the function, so a destructured default like
// `{ a = {} } = {}` in the parameter list doesn't get mistaken for the body's closing brace) and
// asserts normalized-whitespace textual equality. Canonical wins on any drift.
function extractFunctionBody(src, name) {
  const sig = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!sig) return null;
  const start = sig.index;
  // walk the parameter list to its matching ')' first, so a destructured-default brace inside the
  // parameter list is never mistaken for the function body's opening '{'.
  let i = src.indexOf('(', start);
  let pdepth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') pdepth++;
    else if (src[i] === ')') { pdepth--; if (pdepth === 0) { i++; break; } }
  }
  const braceStart = src.indexOf('{', i);
  if (braceStart === -1) return null;
  let bdepth = 0, j = braceStart;
  for (; j < src.length; j++) {
    if (src[j] === '{') bdepth++;
    else if (src[j] === '}') { bdepth--; if (bdepth === 0) { j++; break; } }
  }
  return src.slice(start, j);
}
const normWs = (s) => s.replace(/\s+/g, ' ').trim();

// name -> the file that owns the CANONICAL, tested copy (review-workflow.mjs inlines all of these
// because the Workflow sandbox has no module/filesystem access — see CLAUDE.md's Workflow-DSL
// exception). firstPassModel/shouldEscalate are DELIBERATELY not inlined (the workflow uses the
// simpler group-level severity check instead — see the batched-verify comment in verify.mjs and the
// `doesNotMatch(/function firstPassModel\(/)` guard in the meta test above), so they are not in this
// list: there is no inlined copy to sync against.
const SYNCED_FUNCTIONS = [
  ['normPath', '../lib/trim-diff.mjs'],
  ['sliceName', '../lib/trim-diff.mjs'],
  ['unquoteGitPath', '../lib/trim-diff.mjs'],
  ['isOnRiskPath', '../lib/verify.mjs'],
  ['distributeSeats', '../lib/verify.mjs'],
  ['binByFile', '../lib/verify.mjs'],
  ['groupForVerification', '../lib/verify.mjs'],
  ['selectForVerification', '../lib/verify.mjs'],
  ['resolveVerification', '../lib/verify.mjs'],
  ['partition', '../lib/verify.mjs'],
  ['expandAspects', '../lib/review-orchestration.mjs'],
  ['intentBrief', '../lib/review-orchestration.mjs'],
  ['briefFor', '../lib/review-orchestration.mjs'],
  ['synthIntent', '../lib/review-orchestration.mjs'],
  ['criticIntent', '../lib/review-orchestration.mjs'],
  ['screenPacket', '../lib/review-orchestration.mjs'],
  ['selectGaps', '../lib/review-orchestration.mjs'],
  ['historyBlock', '../lib/review-orchestration.mjs'],
  ['testSignalBlock', '../lib/review-orchestration.mjs'],
  ['reviewerAddendum', '../lib/review-orchestration.mjs'],
  ['dedupeFindings', '../lib/review-orchestration.mjs'],
  ['intentContext', '../lib/review-orchestration.mjs'],
  ['truncate', '../lib/review-orchestration.mjs'],
];

test('every inlined function body stays byte-for-byte (whitespace-normalized) in sync with its canonical source', () => {
  const wf = readFileSync(new URL('../lib/review-workflow.mjs', import.meta.url), 'utf8');
  for (const [name, canonicalPath] of SYNCED_FUNCTIONS) {
    const canonSrc = readFileSync(new URL(canonicalPath, import.meta.url), 'utf8');
    const canonBody = extractFunctionBody(canonSrc, name);
    const inlinedBody = extractFunctionBody(wf, name);
    assert.ok(canonBody, `${name}: not found in canonical ${canonicalPath}`);
    assert.ok(inlinedBody, `${name}: not found inlined in review-workflow.mjs`);
    assert.equal(normWs(inlinedBody), normWs(canonBody),
      `${name}: inlined copy in review-workflow.mjs has drifted from the canonical ${canonicalPath} (canonical wins — align the inlined copy)`);
  }
});
