import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandAspects, findingKey, newCaps, canSpawn, recordSpawn, buildReportPayload, pluginAgent, PLUGIN_NS, inDiffScope, partitionByScope, intentBrief, screenPacket, selectGaps, CONSEQUENCE_DIRECTIVE, historyBlock, testSignalBlock, reviewerAddendum, DOUBLE_RUN_AGENTS, isDoubleRunAgent, dedupeFindings } from '../lib/review-orchestration.mjs';

test('expandAspects = agents × shards, dims carried as a list', () => {
  const aspects = expandAspects(
    { D2: 'correctness-reviewer', D3: 'vuln-reviewer' },
    [{ label: 'A', files: ['a.ts'] }, { label: 'B', files: ['b.ts'] }],
  );
  assert.equal(aspects.length, 4);
  assert.deepEqual(aspects[0], { dims: ['D2'], agent: 'correctness-reviewer', shardId: 'A', files: ['a.ts'] });
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
  assert.deepEqual(d3[0], { dims: ['D3'], agent: 'vuln-reviewer', shardId: 'all', files: ['a.ts', 'b.ts'] });
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

import { readFileSync } from 'node:fs';
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
  assert.match(ba, /diffIndex: buildDiffIndex\(diffText\)/, 'build-args must precompute the diffIndex from diff.txt');
  assert.doesNotMatch(ba, /\bdiff,\n/, 'build-args must not carry the diff TEXT in args');
  // the sandbox consumes the passed diffIndex for off-diff demotion (it can no longer build one).
  assert.match(wf, /partitionByScope\(synth\.findings \?\? \[\], diffIndex/, 'the workflow must demote using the passed-in diffIndex');
  assert.doesNotMatch(wf, /function buildDiffIndex\(/, 'buildDiffIndex must live in build-args (via trim-diff), not the sandbox');
  // normPath is still needed inline (inDiffScope keys on it); sectionPath went with filterDiff.
  assert.match(wf, /const normPath =/);
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
      { label: 'drive-by', kind: 'extra', scrutinize: true },
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

// --- S6.2/S6.3/S6.4: per-reviewer packet addenda ---
test('CONSEQUENCE_DIRECTIVE names the caller list + demands a needs-human question when unsure', () => {
  assert.match(CONSEQUENCE_DIRECTIVE, /caller list/i);
  assert.match(CONSEQUENCE_DIRECTIVE, /needs-human question/i);
  assert.match(CONSEQUENCE_DIRECTIVE, /uncertain:true/);
});

test('historyBlock renders only files with fix history, else empty', () => {
  assert.equal(historyBlock({}), '');
  assert.equal(historyBlock(null), '');
  assert.equal(historyBlock({ 'a.js': [] }), '');               // no subjects → nothing
  const b = historyBlock({ 'src/pay.js': ['fix: rounding', 'revert bad cap'], 'x.js': [] });
  assert.match(b, /PRIOR BUG HISTORY/);
  assert.match(b, /src\/pay\.js: fix: rounding \| revert bad cap/);
  assert.doesNotMatch(b, /x\.js/);                              // history-less file omitted
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
  const history = { 'src/a.js': ['fix: bug'] };
  const testSignal = { ran: true, passed: false, failing: ['t1'] };
  const corr = reviewerAddendum('correctness-reviewer', { history, testSignal });
  assert.match(corr, /CROSS-FILE CONSEQUENCE/);       // S6.2
  assert.match(corr, /PRIOR BUG HISTORY/);            // S6.3
  assert.doesNotMatch(corr, /EXECUTED TEST SIGNAL/);  // D5-only, not correctness
  const d5 = reviewerAddendum('test-adequacy-reviewer', { history, testSignal });
  assert.match(d5, /EXECUTED TEST SIGNAL/);           // S6.4
  assert.doesNotMatch(d5, /CROSS-FILE CONSEQUENCE/);
  assert.doesNotMatch(d5, /PRIOR BUG HISTORY/);       // history rides correctness, not D5
  assert.equal(reviewerAddendum('vuln-reviewer', { history, testSignal }), ''); // everyone else: nothing
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
  // the high-tier screen gates on the discovery flag and reuses completeness-critic on haiku
  assert.match(src, /plan\.discovery\?\.completenessScreen/, 'the screen must gate on completenessScreen');
  assert.match(src, /label: 'completeness-screen'/, 'the screen dispatch must be labelled');
  assert.match(src, /reviewerAddendum\(a\.agent, \{ history, testSignal \}\)/, 'reviewers must get the S6 addendum');
  assert.match(src, /const \{ plan, bundle, diffPath, contextPackPath, diffIndex, history, testSignal,/, 'history + testSignal must be destructured from args');
});
