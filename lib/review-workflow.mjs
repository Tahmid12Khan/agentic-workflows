export const meta = {
  name: 'acr-review',
  description: 'Adversarial code review fan-out: intent, dimension review, batched sonnet-first Verify (≤N groups + 1 opus reverify guard), synthesize, render.',
  phases: [
    { title: 'Intent' },
    { title: 'Review' },
    { title: 'Verify' },
    { title: 'Synthesize' },
  ],
};

// --- inlined pure helpers (canonical + tested: lib/review-orchestration.mjs) ---
const findingKey = (f = {}) => `${f.file}:${f.line}:${(f.title ?? '').toLowerCase().trim()}`;
// One aspect per (AGENT × shard): dims sharing an agent (correctness → D1/D2/D12, data-store →
// D6/D8) fold into ONE aspect carrying `dims: [...]` instead of spawning a duplicate agent per dim.
// A shard carries EITHER an inline `files` array or a `manifest` path + `count` (the by-reference
// form build-args.mjs writes); both propagate to the aspect unchanged.
function expandAspects(dimensionAgents = {}, shards = [], { unsharded = [], allManifest = null, allParts = null } = {}) {
  const list = shards.length ? shards : [{ label: 'all', files: [] }];
  const whole = list.flatMap((s) => s.files ?? []);
  const wholeCount = list.reduce((n, s) => n + (s.count ?? (s.files ?? []).length), 0);
  const single = new Set(unsharded);
  const byKey = new Map();
  const order = [];
  const add = (dim, agent, shardId, files, manifest, count, parts) => {
    const key = `${agent} ${shardId}`;
    let a = byKey.get(key);
    if (!a) { a = { dims: [], agent, shardId, files, manifest, count, parts }; byKey.set(key, a); order.push(a); }
    if (!a.dims.includes(dim)) a.dims.push(dim);
  };
  for (const [dim, agent] of Object.entries(dimensionAgents)) {
    if (!agent) continue;
    if (single.has(dim)) { add(dim, agent, 'all', whole, allManifest, wholeCount, allParts); continue; }
    for (const s of list) add(dim, agent, s.label, s.files ?? [], s.manifest ?? null, s.count ?? (s.files ?? []).length, s.parts ?? null);
  }
  return order;
}
// Compact intent brief for the dimension reviewers + gap re-dispatch: criteria + mismatches + only
// the scrutiny-flagged groups. Bulky prose (statedIntent/derivedIntent/expectedTests/outOfScope/
// extraIntents/domain model) is reserved for the deep consumers (completeness-critic + synth).
// Falls back to the raw value on a schema miss so a reviewer is never starved of intent.
// COST LEVER: scrutinize-group `files` are reduced to basenames — the reviewer holds every full path
// it owns in its shard manifest, so a basename is enough to recognize a flagged file.
function intentBrief(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    scrutinize: (intent.groups ?? []).filter((g) => g?.scrutinize)
      .map((g) => (Array.isArray(g?.files) ? { ...g, files: g.files.map((f) => String(f).split('/').pop()) } : g)),
  };
}

// COST LEVER (per-agent intent): only correctness (D1 intent alignment is its dimension) and
// test-adequacy ("does each criterion have a test") ACT on the criteria; the other ~12 reviewers name
// them once in their input-packet boilerplate and never check them. briefFor gives those the summary
// alone. Keyed by AGENT, so the block stays byte-identical across that agent's aspects and keeps
// leading the cacheable prefix.
const CRITERIA_AGENTS = new Set(['correctness-reviewer', 'test-adequacy-reviewer']);
function briefFor(agent, brief) {
  if (!brief || typeof brief !== 'object') return brief;
  return CRITERIA_AGENTS.has(agent) ? brief : { summary: brief.summary };
}

// The synthesizer's slice: criteria (its traceability matrix) + mismatches + summary. openQuestions
// stays a separate LABELLED term in the prompt (the rule routing it into needsHuman binds to that
// name), which is also why it is not repeated here. Nothing else in review-synthesizer.md is read.
function synthIntent(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
  };
}

// The exhaustive critic's slice: every field kept maps to a gap kind it may emit (criteria/mismatches
// → uncovered-criterion, expectedTests → missing-test, businessRisks → unreviewed-risk-path,
// openQuestions → unverified-claim) plus the group clustering. Per-group FILE lists are dropped: this
// critic already receives the full diff and the changed-file manifest. The cheap SCREEN keeps the RAW
// intent instead — it has no diff and no file list, so those paths are its only re-dispatch targets.
function criticIntent(intent) {
  if (!intent || typeof intent !== 'object') return intent;
  return {
    summary: intent.summary,
    acceptanceCriteria: intent.acceptanceCriteria,
    mismatches: intent.mismatches,
    expectedTests: intent.expectedTests,
    businessRisks: intent.businessRisks,
    openQuestions: intent.openQuestions,
    groups: (intent.groups ?? []).map(({ files, ...rest }) => rest),
  };
}

// --- inlined intentContext (canonical + tested: lib/review-orchestration.mjs) ---
function truncate(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function intentContext(bundle = {}, { maxTotal = 12000 } = {}) {
  const parts = [];
  if (bundle?.pr) {
    const title = truncate(bundle.pr.title, 300);
    const body = truncate(bundle.pr.body, 4000);
    parts.push(`PR: ${title}\n${body}`.trim());
  }
  const comments = (bundle?.existingComments ?? []).slice(0, 10)
    .map((c) => `- ${c?.author ?? '?'}: ${truncate(c?.body, 500)}`);
  if (comments.length) parts.push(`Existing PR comments:\n${comments.join('\n')}`);
  const commits = (bundle?.commits ?? []).slice(0, 20).map((c) => `- ${truncate(c?.subject, 200)}`);
  if (commits.length) parts.push(`Commits:\n${commits.join('\n')}`);
  const tickets = (bundle?.tickets ?? []).map((t) => {
    const head = `${t?.tracker ?? 'issue'} ${t?.key ?? ''}: ${t?.title ?? ''}`;
    const desc = t?.description ?? t?.body ?? '';
    return truncate(desc ? `${head} — ${desc}` : head, 1000);
  });
  if (tickets.length) parts.push(`Linked tickets:\n${tickets.join('\n')}`);
  return truncate(parts.join('\n\n'), maxTotal);
}

// --- inlined S7 helpers (canonical + tested: lib/review-orchestration.mjs) ---
// S7.1: correctness + vuln reviewers run twice in exhaustive mode (real decorrelation); their two
// passes are unioned + deduped by findingKey (first wins; deterministic) before Verify.
const DOUBLE_RUN_AGENTS = new Set(['correctness-reviewer', 'vuln-reviewer']);
const isDoubleRunAgent = (agent) => DOUBLE_RUN_AGENTS.has(agent);
function dedupeFindings(findings = []) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const k = findingKey(f);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

// --- inlined S6 helpers (canonical + tested: lib/review-orchestration.mjs) ---
// S6.1 completeness screen packet: coverage metadata only (dims ran + finding titles + raw intent),
// NO diff — so it flags dimension/criterion coverage gaps, never untraced-taint.
function screenPacket({ plan = {}, findings = [], intent = {}, extraDims = [] } = {}) {
  return {
    mode: 'screen',
    dimensionsRan: [...(plan.dimensions ?? []), ...extraDims],
    findingTitles: (findings ?? []).map((f) => ({ title: f?.title, dimension: f?.dimension })).filter((t) => t.title),
    harvester: intent ?? {},   // raw intent-analyzer output (acceptance criteria live here), NOT a coverage matrix
  };
}
// keep only re-dispatchable gaps (naming a REAL bundled agent) and cap the count (6 exhaustive / 1-2
// screen). validAgents drops hallucinated names (e.g. "intent-verifier") before re-dispatch — see
// selectGaps in lib/review-orchestration.mjs (canonical, tested).
function selectGaps(gaps = [], max = 6, validAgents = null) { const ok = validAgents == null ? null : new Set(validAgents); return (gaps ?? []).filter((g) => g?.dispatch?.agent && (ok == null || ok.has(g.dispatch.agent))).slice(0, Math.max(0, max)); }
// S6.2 cross-file consequence directive — appended to the correctness-reviewer packet only.
const CONSEQUENCE_DIRECTIVE =
  'CROSS-FILE CONSEQUENCE: for each changed exported symbol, use the CONTEXT PACK caller list to '
  + 'state in ONE line whether each listed caller\'s assumption still holds (signature, nullability, '
  + 'ordering, error behavior). If you cannot tell from the pack, emit a needs-human question '
  + '(uncertain:true, confidence < 80), not an asserted finding.';
// S6.3 bug-history prior (history.mjs) → attached BY REFERENCE (args.historyPath); a Read
// instruction, '' when no fix/revert history (build-args.mjs emits null).
function historyBlock(historyPath) {
  if (!historyPath) return '';
  return `PRIOR BUG HISTORY: Read ${historyPath} — recent fix/revert/hotfix commits touching the changed files, shaped { history: { <file>: [<commit subject>, ...] }, notes: [...] }. A file with a history of fixes deserves extra scrutiny.\n`;
}
// S6.4 executed-test signal (test-signal.mjs) → test-adequacy-reviewer packet, '' when not run.
function testSignalBlock(signal) {
  if (!signal || !signal.ran) return '';
  if (signal.passed) return 'EXECUTED TEST SIGNAL: the project test suite PASSED on the reviewed code.\n';
  const names = (signal.failing ?? []).filter(Boolean);
  const list = names.length ? ` Failing: ${names.join(', ')}.` : '';
  return `EXECUTED TEST SIGNAL: the project test suite FAILED on the reviewed code.${list} Weigh this against the diff — an uncovered/broken path is a real finding.\n`;
}
// the per-reviewer S6 addendum (which reviewer gets which extra signal). Empty inputs contribute ''.
function reviewerAddendum(agent, { historyPath, testSignal } = {}) {
  const parts = [];
  if (agent === 'correctness-reviewer') {
    parts.push(CONSEQUENCE_DIRECTIVE);
    const hb = historyBlock(historyPath);
    if (hb) parts.push(hb);
  } else if (agent === 'test-adequacy-reviewer') {
    const tb = testSignalBlock(testSignal);
    if (tb) parts.push(tb);
  }
  return parts.length ? '\n' + parts.join('\n') : '';
}

// --- inlined diff-scope demotion (canonical + tested: lib/review-orchestration.mjs
// inDiffScope/partitionByScope; the diffIndex it consumes is precomputed by build-args.mjs
// via lib/trim-diff.mjs buildDiffIndex and arrives in `args.diffIndex`) ---
// ARGS-BY-REFERENCE: the diff is NEVER inlined into this sandbox — reviewers/verifiers Read it
// from `args.diffPath` and focus on their file list, so the sandbox no longer trims diff text
// (the old filterDiff/stripNoise are gone). The one diff-derived datum the sandbox still needs
// is the compact line-range index for off-diff demotion; it is passed in, not recomputed here.
// Findings anchored outside the actual change are advisory-only: shown in the report but
// excluded from the verdict/gate/comments. Demotion keys on the FILE, never a missing line,
// so gate-worthy line-less (D1/intent) and deletion findings are never silently un-gated.
function unquoteGitPath(s) {
  if (typeof s !== 'string' || s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const inner = s.slice(1, -1);
  const bytes = [];
  const SIMPLE = { '\\': 0x5c, '"': 0x22, t: 0x09, n: 0x0a, r: 0x0d, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b };
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      const next = inner[i + 1];
      if (next in SIMPLE) { bytes.push(SIMPLE[next]); i++; continue; }
      const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1));
      if (octal) { bytes.push(parseInt(octal[0], 8) & 0xff); i += octal[0].length; continue; }
      bytes.push(0x5c);   // unrecognized escape → keep the backslash literally
      continue;
    }
    const code = c.codePointAt(0);
    if (code < 0x80) bytes.push(code);
    else bytes.push(...Buffer.from(c, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}
function normPath(p) {
  if (typeof p !== 'string') return '';
  const s = unquoteGitPath(p.split('\t')[0].trim());
  return s.replace(/^[ab]\//, '').trim();
}
function sliceName(path) {
  const s = normPath(path);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(36)}.patch`;
}
function inDiffScope(finding, diffIndex = {}, slack = 3) {
  const file = normPath(finding?.file);
  if (!file) return true;
  const ranges = diffIndex[file];
  if (!ranges) return false;
  if (ranges.length === 0) return true;
  const line = Number(finding?.line);
  if (!Number.isInteger(line) || line <= 0) return true;
  return ranges.some(([s, e]) => line >= s - slack && line <= e + slack);
}
function partitionByScope(findings = [], diffIndex = {}, slack = 3) {
  const inScope = [], outOfDiff = [];
  for (const f of findings) (inDiffScope(f, diffIndex, slack) ? inScope : outOfDiff).push(f);
  return { inScope, outOfDiff };
}

// Plugin agents register namespaced (adversarial-code-review:<name>); a bare name
// only resolves on the plugin's own repo. Resolve every bundled agentType through this.
const pluginAgent = (t) => (!t || t === 'general-purpose' || t.includes(':') ? t : `adversarial-code-review:${t}`);

// --- inlined verification policy (canonical + tested: lib/verify.mjs) ---
// Selecting which findings to verify + resolving verdicts is pure: run it inline
// rather than spawning a general-purpose executor agent to `node verify.mjs resolve`.
// Config is resolved ONCE in plan.mjs (which can import verify.mjs); the sandbox consumes the
// resolved camelCase plan.verify directly (see `policy` below) and must NOT re-resolve raw config —
// so verifyPolicy/cleanVerify are intentionally NOT inlined here, only the pure decision helpers are.
const DEFAULT_VERIFY = { maxPassesPerAspect: 3, maxSubagentsPerAspect: 3, reverifyBelow: 80, reportConfidence: 80, escalateUncertain: true, maxVerifierAgents: 5, verifyModel: 'opus', modelFirst: 'sonnet', modelEscalate: 'opus', escalateDirectSeverity: ['critical'] };
const HOT_SEVERITIES = ['critical', 'important'];
// Batch selected findings into ≤ maxAgents verifier groups by (verifier lens, file) — canonical +
// tested in lib/verify.mjs groupForVerification. Every finding lands in exactly one group (the cap
// bounds AGENT COUNT, never coverage); lens separation (taint vs generic) is preserved; each group's
// diff is paid once per agent. Deterministic (no Date/random; stable index tie-breaks).
function groupForVerification(findings = [], maxAgents = DEFAULT_VERIFY.maxVerifierAgents) {
  const items = (findings ?? []).filter((f) => f && f.verifier);
  if (!items.length) return [];
  const cap = Math.max(1, Math.floor(maxAgents) || 0);
  const byVerifier = new Map();
  for (const f of items) {
    if (!byVerifier.has(f.verifier)) byVerifier.set(f.verifier, []);
    byVerifier.get(f.verifier).push(f);
  }
  const verifiers = [...byVerifier.keys()];
  // Give each lens ≥1 seat (never merge across lenses), then hand the remaining seats to the
  // most crowded lens. total ≥ verifiers.length so lens separation always holds.
  const seats = distributeSeats(verifiers.map((v) => byVerifier.get(v).length), Math.max(cap, verifiers.length));
  const groups = [];
  verifiers.forEach((v, i) => {
    for (const bucket of binByFile(byVerifier.get(v), seats[i])) {
      groups.push({ verifier: v, files: [...new Set(bucket.map((f) => f.file).filter(Boolean))], findings: bucket });
    }
  });
  return groups;
}
function distributeSeats(loads, total) {
  const seats = loads.map(() => 1);
  let remaining = total - seats.length;
  while (remaining > 0) {
    let best = 0;
    for (let i = 1; i < loads.length; i++) {
      if (loads[i] / seats[i] > loads[best] / seats[best]) best = i;
    }
    seats[best]++;
    remaining--;
  }
  return seats;
}
function binByFile(findings, nBuckets) {
  const byFile = new Map();
  for (const f of findings) { const k = f.file ?? ''; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(f); }
  const fileGroups = [...byFile.values()];
  const n = Math.max(1, Math.min(Math.floor(nBuckets) || 1, fileGroups.length));
  if (fileGroups.length <= n) return fileGroups;
  const sorted = fileGroups.slice().sort((a, b) => b.length - a.length);
  const buckets = Array.from({ length: n }, () => []);
  for (const g of sorted) { let s = 0; for (let i = 1; i < buckets.length; i++) if (buckets[i].length < buckets[s].length) s = i; buckets[s].push(...g); }
  return buckets;
}
function isOnRiskPath(f, riskPaths) {
  if (riskPaths.size === 0) return false;
  const file = f.file ?? '';
  for (const r of riskPaths) if (file.toLowerCase().includes(r)) return true;
  return false;
}
// Re-check ONLY the unsure: low-confidence, explicitly uncertain, or high-severity on a
// risk path. A confident, non-risk finding is trusted and ships without a verifier pass.
function selectForVerification(findings, policy = DEFAULT_VERIFY, opts = {}) {
  const riskPaths = new Set(opts.riskPaths ?? []);
  return (findings ?? []).filter((f) => {
    if (f.severity === 'critical') return true;        // WS6: always verify a critical (incl. off-diff)
    if (f.uncertain === true) return true;
    if (f.confidence == null) return true;             // unscored → always verify, never a free pass (distinct from an explicit 0)
    if (f.confidence < policy.reverifyBelow) return true;
    const hot = ['critical', 'important'].includes(f.severity);
    if (hot && isOnRiskPath(f, riskPaths)) return true;
    return false;
  });
}
function resolveVerification(finding, verdicts = [], policy = DEFAULT_VERIFY) {
  const used = verdicts.slice(0, policy.maxVerifierPasses);
  const real = used.filter((v) => v.verdict === 'real').length;
  const refuted = used.filter((v) => v.verdict === 'refuted').length;
  const passes = 1 + used.length; // original review + verifier passes

  // An unscored finding (confidence == null) is untrustworthy, not maximally
  // confident — treat it as low so the >=2-confirmations rule applies and it can't
  // ship unverified. Distinct from an explicit 0 only at SELECTION.
  const scored = finding.confidence != null;
  let decision, confidence = scored ? finding.confidence : 0;
  const wasLowConf = !scored || confidence < policy.reportConfidence;
  // High-stakes = the cases the selector force-verifies / cares most about missing.
  const hot = ['critical', 'important'].includes(finding.severity);
  // A 2nd refutation is only reachable when the budget affords >=2 verifier passes.
  // Under a starved budget (maxVerifierPasses < 2) a lone refuter IS the full pass,
  // so let it drop — otherwise a genuinely-false hot finding would be undroppable
  // and pile up in needs-human forever.
  const twoLooksAffordable = policy.maxVerifierPasses >= 2;
  if (used.length === 0) {
    decision = 'keep';
  } else if (refuted > real) {
    // Symmetric burden of proof: when a 2nd look was affordable, one refuter must not
    // drop a high-stakes finding — hand it to a human instead, never silently dropped.
    if (hot && refuted < 2 && twoLooksAffordable && policy.escalateUncertain) {
      decision = 'needs-human';
    } else {
      decision = 'drop';
    }
  } else if (real > refuted) {
    // A finding that entered BECAUSE it was low-confidence needs >=2 confirmations;
    // a single "real" vote must not bootstrap a weak finding past the floor.
    if (wasLowConf && real < 2) {
      decision = policy.escalateUncertain ? 'needs-human' : 'drop';
    } else {
      decision = 'keep';
      confidence = Math.max(confidence, 80);
    }
  } else {
    // tie / all-uncertain after the cap
    decision = policy.escalateUncertain ? 'needs-human' : 'drop';
  }
  return {
    ...finding,
    confidence,
    verify: { passes, real, refuted, decision, capped: verdicts.length > used.length, lenses: [...new Set(used.map((v) => v.lens).filter(Boolean))] },
    decision,
  };
}
function partition(resolved, policy = DEFAULT_VERIFY) {
  const report = [], dropped = [], needsHuman = [];
  for (const f of resolved) {
    if (f.decision === 'needs-human') needsHuman.push(f);
    else if (f.decision === 'drop') dropped.push(f);
    else if ((f.confidence ?? 0) >= policy.reportConfidence) report.push(f); // unscored never ships unverified
    else needsHuman.push({ ...f, decision: 'needs-human' }); // survived but still low-conf
  }
  return { report, dropped, needsHuman };
}

// --- schemas (force structured sub-agent output) ---
const FINDING = {
  type: 'object',
  properties: {
    dimension: { type: 'string' }, severity: { enum: ['critical', 'important', 'minor', 'suggestion'] },
    file: { type: 'string' }, line: { type: 'number' },
    // Last original line of a multi-line fix range (line..endLine, inclusive); unset/absent means
    // the finding + any fixCode apply to the single `line`. Only ever copied through, never inferred.
    endLine: { type: 'number' },
    title: { type: 'string' },
    evidence: { type: 'string' }, fix: { type: 'string' },
    // Exact replacement, set only when a reviewer is letter-for-letter confident — comments.mjs
    // renders it as a ```suggestion block GitHub can apply in one click (single-line at `line`, or
    // spanning line..endLine). Empty/absent falls back to the prose `fix`.
    fixCode: { type: 'string' },
    confidence: { type: 'number' },
    uncertain: { type: 'boolean' },
    // Carried through synthesis so the report can show verified-vs-trusted per finding. The
    // reviewers leave this empty (verify runs after review); the synthesizer COPIES the verify
    // block the verifier produced — without this field it was silently stripped and no tag showed.
    verify: {
      type: 'object',
      properties: {
        passes: { type: 'number' }, real: { type: 'number' }, refuted: { type: 'number' },
        decision: { type: 'string' }, lenses: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['severity', 'file', 'title'],
};
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: { strengths: { type: 'array', items: { type: 'string' } }, findings: { type: 'array', items: FINDING } },
  required: ['findings'],
};
// Batched verifier output: one verdict per finding, keyed by the finding's `id` (its findingKey,
// copied verbatim from the packet) so the orchestrator can map verdicts back to findings.
const VERDICTS_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, verdict: { enum: ['real', 'refuted', 'uncertain'] },
          lens: { type: 'string' }, rationale: { type: 'string' }, confidence: { type: 'number' },
        },
        required: ['id', 'verdict'],
      },
    },
  },
  required: ['verdicts'],
};
const GAPS_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string' }, what: { type: 'string' }, where: { type: 'string' },
          dispatch: {
            type: 'object',
            properties: { agent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, focus: { type: 'string' } },
            required: ['agent'],
          },
        },
        required: ['kind', 'dispatch'],
      },
    },
    assessment: { type: 'string' },
  },
  required: ['gaps'],
};
// Force the merged intent model to a structured object (was free-form text → escaped-string blob
// broadcast verbatim into every downstream prompt). Structured lets us hand reviewers a COMPACT
// brief (criteria + mismatches + flagged groups) instead of the full prose model — the bulky
// statedIntent/derivedIntent/expectedTests/outOfScope + the domain-logic fields stay only on the
// deep consumers (completeness-critic, synth). This is the FULL UNION of the former intent-harvester
// + business-logic-analyzer contracts (S3 of plan.md); acceptanceCriteria is REQUIRED because four
// consumers read it (reviewer brief, completeness-critic, gap re-dispatch, synth traceability).
// Mirrors agents/intent-analyzer.md's documented shape.
const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, statedIntent: { type: 'string' }, derivedIntent: { type: 'string' },
    acceptanceCriteria: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' } } } },
    expectedTests: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
    mismatches: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' } } } },
    groups: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, intent: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, kind: { type: 'string' }, withinScope: { type: 'boolean' }, note: { type: 'string' }, scrutinize: { type: 'boolean' } } } },
    extraIntents: { type: 'array', items: { type: 'string' } },
    // business-logic union (former business-logic-analyzer): domain model + assumptions + open questions.
    model: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, grounded: { type: 'boolean' }, source: { type: 'string' } } } },
    openQuestions: { type: 'array', items: { type: 'object', properties: { question: { type: 'string' }, file: { type: 'string' }, why: { type: 'string' } } } },
    businessRisks: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, severity: { type: 'string' } } } },
  },
  required: ['acceptanceCriteria'],
};
const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' }, summaryPoints: { type: 'array', items: { type: 'string' } },
    strengths: { type: 'array', items: { type: 'string' } },
    criteria: { type: 'array' }, findings: { type: 'array', items: FINDING },
    needsHuman: { type: 'array' }, skipped: { type: 'array' },
  },
  required: ['findings'],
};

// args arrives as a JSON STRING (confirmed via spike), not a parsed object — parse defensively.
// A malformed string (transcription drift over a large tool-call payload) would otherwise throw a
// bare SyntaxError here at module top-level, before any agent spawns — a 0-agent death that reads
// as "corruption" instead of "re-emit the call". Re-throw with an actionable message instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : (args ?? {});
} catch (e) {
  throw new Error(`args JSON malformed (${e.message}) — likely tool-call transcription drift over a large payload; re-emit the Workflow call with the exact contents of args.json.`);
}
const { plan, bundle, diffPath, contextPackPath, diffIndex, historyPath, testSignal, shards, routing, flags, startedAt, prNumber, checkout, diffRanges, sliceDir, doctrineText, contextPackStats, knownFalsePositives, allManifest, allParts, buildNotes } = A;
// FILE LIST BY REFERENCE: neither `plan.files` nor the per-shard file arrays exist in args any more —
// build-args.mjs wrote them to <scratch>/manifests/ and sent a path per SHARD instead of a path per
// FILE (its single largest term). Nothing in the sandbox needs the list: every consumer is either an
// AGENT (which Reads its manifest) or the off-diff demotion below (which re-derives each finding's
// slice key from the finding's OWN path). `plan.files` is therefore deliberately left undefined, which
// also keeps it out of the returned payload the orchestrator must transcribe for report.mjs — nothing
// downstream reads it (report.mjs uses plan.fileCount / plan.filesCapped).
const fileListRef = allManifest
  ? `The changed-file list is at ${allManifest} — Read it; one "<path>\\t<diff-slice path>" per line.`
  : `Changed files: ${JSON.stringify((shards ?? []).flatMap((s) => s.files ?? []))}.`;
// Shared context pack (context-pack.mjs, built once in /review step 3): the enclosing definitions
// of changed code, import blocks, and in-repo callers of changed exports. ARGS-BY-REFERENCE: it is
// on disk at contextPackPath, so a reviewer is told to Read it FIRST (before the diff) and then
// needs at most a few extra Read/Grep calls (S2 of plan.md). The instruction is byte-identical
// across every aspect of the same reviewer agent, so it LEADS the packet and prompt-caches across
// them. null when the pre-step was skipped → reviewers fall back to their own Read/Grep. The caller
// section rides in the pack; the correctness reviewer is its primary consumer (S6.2).
const packBlock = contextPackPath
  ? `A shared CONTEXT PACK (enclosing definitions of the changed code, import blocks, and in-repo callers of the changed exports) is on disk at ${contextPackPath} — Read it FIRST, before the diff.\n\n`
  : '';
// WS1 review doctrine (args.doctrineText = {agent: concatenated fragment text}, resolved in
// build-args.mjs from lib/doctrine.mjs, tier >= standard only): inline the doctrine fragment TEXT
// straight into the prompt instead of pointing the reviewer at a Read — the fragments are small
// (<=3.7KB/agent) so this saves a whole turn. Keyed by AGENT so it is byte-identical across that
// agent's aspects/shards → stays in the cacheable prefix. '' for an agent with no mapped doctrine or
// a trivial/low tier ({} doctrineText).
const doctrineFor = (agent) => {
  const text = (doctrineText ?? {})[agent];
  if (!text) return '';
  return `Review-DOCTRINE notes for this agent — advisory guidance refining how you rank, phrase, and structure findings (not the finding contract):\n${text}\n\n`;
};
// ARGS-BY-REFERENCE: every agent Reads the full diff from diffPath itself and focuses on its file
// list — the sandbox no longer inlines diff text. Reviewers/verifiers/critic all point at diffPath;
// intent is additionally told to ignore lockfile/build-artifact/vendored churn (the old stripNoise).
const diffRead = `Read the diff at ${diffPath}.`;
// COST LEVER — per-aspect diff slicing: build-args.mjs wrote each REVIEWED file's hunks to its own
// slice under args.sliceDir, named by `sliceName` (derived from the path) so args carries the
// directory once instead of a path→path map with one long absolute entry per file. A file-scoped
// agent (a dimension reviewer, a generic verifier group, a gap re-dispatch) Reads ONLY the slices
// for its files instead of the whole diff — the dominant input-token cost, otherwise paid in full
// once per agent. It is a pure optimization: with no sliceDir (slicing skipped or a slice-name
// collision), or for a file outside the reviewed set (a critic gap may name one), it FALLS BACK to
// the full diff so a reviewer is never starved. Callers that must reason cross-file (D3/taint,
// intent, the reverify guard, the exhaustive critic) deliberately pass the full diffRead instead.
// The reviewed set is recognized by SLICE NAME (args.diffRanges is keyed by it, one entry per reviewed
// file that has new-side hunks) — the sandbox no longer carries the path list to check against. A
// reviewed file with NO new-side hunks (rename, mode change, binary) has no diffRanges entry, so a
// verifier/critic naming it falls back to the full diff; that is the right answer anyway, since its
// slice is only a placeholder line.
const reviewedSlices = new Set(Object.keys(diffRanges ?? {}));
const slicesFor = (files = []) => (sliceDir
  ? [...new Set((files ?? []).map(normPath).map(sliceName).filter((n) => reviewedSlices.has(n)).map((n) => `${sliceDir}/${n}`))]
  : []);
const diffReadFor = (files) => {
  const s = slicesFor(files);
  if (!s.length) return diffRead;   // no slice for these files → full diff (never a starved reviewer)
  return `Read the per-file diff slice(s) for the file(s) you are reviewing: ${s.join(', ')} — these hold the complete changed hunks for those files (Read only these, not the whole diff).`;
};
// The reviewer's SCOPE — which files it owns and where to read their hunks — in whichever form the
// aspect carries. `manifest` (the by-reference form, one Read for both answers) keeps the per-file
// paths out of args entirely; `files` is the legacy inline form, still used by the small aspects
// route.mjs builds and by any run where the manifest write failed. D3 (security) is exempt from
// slicing in both forms: it is unsharded over every changed file and must see the FULL diff for
// cross-file taint source→sink.
const scopeFor = (a, dimList) => {
  const isD3 = (a.dims ?? []).includes('D3');
  if (isD3) {
    const allBundleParts = allParts ?? [];
    if (allBundleParts.length) {
      return `Your review scope is bundled into ${allBundleParts.length} part(s): ${allBundleParts.join(', ')} — Read ALL of them now, `
        + `in one batch of parallel Read calls (parallel Reads in one turn cost one turn, not one turn per file); `
        + `each part concatenates several files' diff-slice content, with a "=== FILE: <path> ===" header marking `
        + `where one file's hunks end and the next begins.\n\n`
        + `Review EVERY changed file across those parts for dimension(s) ${dimList}.`;
    }
    return `${diffRead}\n\nReview EVERY changed file in that diff for dimension(s) ${dimList}.`;
  }
  const parts = a.parts ?? [];
  if (parts.length) {
    return `Your review scope is bundled into ${parts.length} part(s): ${parts.join(', ')} — Read ALL of them now, `
      + `in one batch of parallel Read calls (parallel Reads in one turn cost one turn, not one turn per file); `
      + `each part concatenates several files' diff-slice content, with a "=== FILE: <path> ===" header marking `
      + `where one file's hunks end and the next begins.\n\n`
      + `Review ONLY the files covered by those parts, for dimension(s) ${dimList}.`;
  }
  if (a.manifest) {
    return `Your review scope is the manifest at ${a.manifest} — Read it first: one "<path>\\t<diff-slice path>" per line, ${a.count ?? 0} file(s). `
      + `Read each listed diff slice (column 2) for that file's complete changed hunks; do NOT read the whole diff.\n\n`
      + `Review ONLY the files listed in that manifest, for dimension(s) ${dimList}.`;
  }
  return `${diffReadFor(a.files)}\n\nReview ONLY these changed files for dimension(s) ${dimList}: ${JSON.stringify(a.files)}.`;
};
// REVIEW.md (plan.reviewInstructions, resolved in plan.mjs): review-SPECIFIC mandatory guidance,
// injected verbatim as the highest-priority, cache-leading block into every finding-generating agent
// (reviewers + intent + critic). Distinct from projectRules (general repo conventions, passed as paths).
// It LEADS each prompt and is byte-identical across aspects, so it prompt-caches like packBlock.
// '' when unset → the block is a no-op that adds no tokens and does not perturb the cache prefix.
const reviewBlock = plan.reviewInstructions
  ? `MANDATORY REVIEW INSTRUCTIONS (highest priority — follow these over general project conventions when they conflict):\n${plan.reviewInstructions}\n\n`
  : '';
// Seeded with the soft-degrade notes build-args.mjs raised BEFORE the Workflow started (an empty
// context pack, a failed manifest write). They travel in args because the pre-steps have no other
// route to the user: /review relays the workflow's `notes` verbatim (step 5). Normally [].
const notes = [...(buildNotes ?? [])];
const agentRuns = {};
const bump = (name) => { agentRuns[name] = (agentRuns[name] ?? 0) + 1; };

// reviewer packet: NEVER includes this chat's history
// intentContext is the REAL PR/comment/commit/ticket digest intent-analyzer.md is designed to
// consume (bundle.summary alone is just a one-line count string) — see intentContext above.
const basePacket = {
  summary: bundle?.summary ?? '',
  projectRules: plan.projectRules ?? [],
  intentContext: intentContext(bundle),
};

// Known accepted false positives (memory.mjs, loaded by build-args.mjs pre-generation): a short
// "don't re-raise these" block prepended to every dimension-reviewer packet, only when non-empty —
// cheaper than the post-hoc suppression in report.mjs (which stays, as a belt-and-braces backstop).
const knownFPBlock = (knownFalsePositives ?? []).length
  ? `Known accepted false positives in this repo — do not re-raise these exact findings:\n${(knownFalsePositives ?? []).map((fp) => `- ${fp.file}: ${fp.title}`).join('\n')}\n\n`
  : '';

// ---------------------------------------------------------------- Triage sanity-check (first reasoning step)
// The deterministic plan.mjs already fixed the tier/dimensions; this is a judgment pass on
// blast radius. A RAISED tier can't safely re-plan mid-flight (dimensions/models arrive fixed
// in args, and the sandbox can't recompute them) so it is surfaced for the human. Dimensions it
// ADDS we CAN honor — they become real review aspects below, resolved via dimensionAgentsAll.
phase('Intent');
const TIER_RANK = { trivial: 0, low: 1, standard: 2, high: 3, critical: 4 };
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: { tier: { type: 'string' }, addDimensions: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
  required: ['tier'],
};
// triage (tier sanity-check) and intent do NOT depend on each other — triage's output only feeds the
// Review phase (extra dims), intent needs none of it — so launch BOTH and await together instead of
// paying their latencies back-to-back. This roughly halves the Intent-phase wall-clock. triage is
// skipped for TRIVIAL only (dims fixed to D2+D13, verify/critic off → a judgment-based dim add is the
// lowest-value call there); low+ KEEPS it. `plan.models` is intentionally omitted from the triage
// prompt: it judges blast radius/tier, never model assignment.
const triageP = plan.tier === 'trivial' ? Promise.resolve(null) : agent(
  `Sanity-check this review tier using judgment about blast radius. Decide from the signals + diff summary + changed-file list — beyond that one manifest, do NOT read files or run git to make this call (only Read a single specific file if a tier decision genuinely hinges on its content). Signals: ${JSON.stringify(plan.signals)}. ` +
  `Draft plan — tier: ${plan.tier}, dimensions: ${JSON.stringify(plan.dimensions)}. ` +
  `${fileListRef} Diff summary: ${plan.diffSummary}.`,
  { agentType: pluginAgent('triage-classifier'), model: 'sonnet', label: 'triage', phase: 'Intent', schema: TRIAGE_SCHEMA },
).then((r) => (bump('triage-classifier'), r)).catch((e) => { notes.push(`triage-classifier failed: ${e.message}`); return null; });

// ---------------------------------------------------------------- Intent
// ONE merged pass (intent-analyzer = former intent-harvester + business-logic-analyzer, S3 of
// plan.md): a single diff payment yields the whole intent model — acceptance criteria, mismatches,
// primary/extra grouping, AND the domain/business-logic model with assumptions + open questions.
// Diff first here is convention, NOT a caching win: intent-analyzer runs ONCE and is a distinct
// agent (own system prompt, sometimes its own model) from the reviewers/verifiers, so its diff does
// NOT prompt-cache with them — cross-agent caching is impossible (the cache key includes the system
// prompt; no user-text ordering bridges two agents). The real reuse is INTRA-agent: the same reviewer
// across shards and the same verifier across same-scope findings (see those passes below); the
// report's per-scope cache-hit% panel shows the actual rate. The prompt enforces STAGED reasoning
// (criteria/groups BEFORE assumptions/questions) so merging the two agents does not collapse the producer→consumer
// reasoning barrier the split gave for free. Runs at low+ (skipped only on the trivial inline path,
// where the Workflow is never invoked) so even low-tier reviewers still get their intent brief.
// S6.3: the deterministic bug-history prior (history.mjs) rides on the intent packet + the
// correctness packets AS A READ INSTRUCTION — args.historyPath is attached BY REFERENCE (like
// contextPackPath/sliceDir), since inlining the raw history object cost 6+ KB on a 69-file PR. ''
// when there is no such history (build-args.mjs emits null), so it costs nothing when absent.
const historyPrior = historyBlock(historyPath);
const intentP = agent(
  `${reviewBlock}` +
  `Read the diff at ${diffPath} (ignore lockfile/build-artifact/vendored churn — focus on the source/test/config changes).\n\nIn ORDER: (1) build the acceptance-criteria model (stated vs derived intent + mismatches), (2) cluster the diff into intent groups (primary vs EXTRA), flagging the groups that need scrutiny, THEN (3) model the domain/business logic — list assumptions + OPEN QUESTIONS (do not guess on material ambiguity). Context: ${JSON.stringify(basePacket)}. Diff summary: ${plan.diffSummary}.${historyPrior ? `\n${historyPrior}` : ''}`,
  // model PINNED to sonnet: a Workflow agent with no model opt inherits the SESSION model — running
  // /review from an opus session silently upgraded intent (+ synth + gap re-dispatch) to opus, blowing
  // the budget. Pin them so cost is deterministic and matches the agent frontmatter (intent = sonnet).
  // label PINNED so the progress UI shows "intent" instead of falling back to the prompt's first line.
  { agentType: pluginAgent('intent-analyzer'), model: 'sonnet', label: 'intent', phase: 'Intent', schema: INTENT_SCHEMA },
).then((r) => (bump('intent-analyzer'), r));

// Await the two independent Intent-phase agents together (launched above).
const [triage, intent] = await Promise.all([triageP, intentP]);

const triageExtraDims = [];
if (triage) {
  if ((TIER_RANK[triage.tier] ?? -1) > (TIER_RANK[plan.tier] ?? -1)) {
    notes.push(`triage-classifier suggests tier ${triage.tier} > computed ${plan.tier}: ${triage.reason ?? ''}`);
  }
  for (const d of triage.addDimensions ?? []) {
    if (!(plan.dimensions ?? []).includes(d) && (plan.dimensionAgentsAll ?? {})[d] && !triageExtraDims.includes(d)) triageExtraDims.push(d);
  }
}

// ---------------------------------------------------------------- Review (barrier) → batched Verify
phase('Review');
// Compact intent brief for the dimension reviewers (intentBrief, inlined above): the criteria they
// trace against, the mismatches to confirm, and ONLY the groups flagged for scrutiny. The full prose
// model + domain-logic fields are reserved for the deep consumers (completeness-critic + synth).
const brief = intentBrief(intent);
// plan.verify is ALREADY RESOLVED (camelCase) by plan.mjs — merge it over the defaults. Do NOT
// re-resolve via cleanVerify (it maps only raw snake_case config, so it would silently revert every
// customized field back to its default). maxVerifierAgents is the per-tier batched-verify budget.
const policy = { ...DEFAULT_VERIFY, ...(plan.verify ?? {}) };
const riskPaths = plan.signals?.riskPaths ?? [];
// D3 (security) consumes the FULL diff regardless of shard (cross-file taint source→sink), so
// sharding it only re-pays the whole diff per shard. Collapse it to ONE aspect over all files.
const aspects = expandAspects(plan.dimensionAgents, shards, { unsharded: ['D3'], allManifest, allParts });
// extra-intent scrutiny + mandatory checks become additional aspects (computed in the main agent via
// route.mjs). These carry INLINE file lists — route.mjs targets a handful of files, so a manifest
// would cost a Read to save nothing.
for (const t of routing?.scrutiny?.targets ?? []) aspects.push({ dims: [t.label], agent: 'correctness-reviewer', shardId: 'scrutiny', files: t.files });
// dimensions triage-classifier judged were missed → real aspects (reviewed + verified like any other),
// scoped to the whole change via the all-files manifest.
for (const d of triageExtraDims) aspects.push({ dims: [d], agent: plan.dimensionAgentsAll[d], shardId: 'triage', files: [], manifest: allManifest, count: plan.fileCount ?? 0 });

// ARGS-BY-REFERENCE: a dimension reviewer Reads the full diff from diffPath and is told to review
// ONLY its aspect's file list (below), so it focuses without the sandbox pre-slicing diff text.
// D3 (security) still reasons over the whole diff for cross-file taint source→sink; the file-list
// scope is advisory focus, not a hard cut, so a reviewer is never starved of a needed hunk.

// ---- Batched verification (all on plan.verify.verifyModel = opus; ≤ maxVerifierAgents groups + 1) ----
// The user's cost lever: instead of one verifier agent PER finding (unbounded, and mostly cold-cache
// since same-prefix agents run concurrently and can't read each other's cache), GROUP the selected
// (unsure) findings by (verifier lens, file) into at most maxVerifierAgents groups (per-tier: 3/5/8)
// and refute a whole group in ONE opus pass — the diff is paid once per group, and agent count stops
// scaling with finding count. Every selected finding is still verified (the cap bounds AGENT COUNT,
// never coverage). A finding NOT selected is trusted and carried through unverified.
const verifierFor = (f) => (f.dimension === 'D3' && plan.discovery?.taint) ? 'taint-verifier' : 'finding-verifier';
const verifyPayload = (f) => ({ id: findingKey(f), dimension: f.dimension, severity: f.severity, file: f.file, line: f.line, title: f.title, evidence: f.evidence, fix: f.fix });
const verifyModel = plan.verify?.verifyModel ?? policy.verifyModel;
// COST LEVER — sonnet-first batched verify: the first-pass refuter groups run on the CHEAP model
// (modelFirst = sonnet), NOT opus. The asymmetry is deliberate — a sonnet false CONFIRM only lets a
// spurious finding through (annoying, human sees it), while a sonnet false REFUTE would MISS a real
// bug; the +1 opus reverify guard below re-checks exactly the refuted/uncertain HOT findings with the
// bias inverted, so opus adjudicates every costly kill. Two exceptions go straight to opus on the
// first pass: a group holding a CRITICAL finding (escalate_direct_severity) and the taint-verifier
// (D3 cross-file security, exhaustive-only) — the cases where even a confirm is worth the strong model.
const firstModel = plan.verify?.modelFirst ?? policy.modelFirst;
const escDirectSev = new Set(policy.escalateDirectSeverity ?? DEFAULT_VERIFY.escalateDirectSeverity);

// One batched verifier group → writes { verdict, lens } per finding id into verdictByKey. taint keeps
// the FULL diff (cross-file source→sink); a generic group is file-scoped, reading only its files'
// slices (diff paid once, sliced, for the group). Diff-first ordering keeps that prefix cacheable if
// the same group scope recurs. A failed group degrades every finding in it to 'uncertain' (never crashes).
const spawnBatchVerifier = (group, verdictByKey) => {
  const payload = group.findings.map(verifyPayload);
  const isTaint = group.verifier === 'taint-verifier';
  const focus = isTaint
    ? 'Trace each finding across ALL changed files (cross-file taint source→sink).'
    : `Focus on the file(s): ${JSON.stringify(group.files)}.`;
  const gDiffRead = isTaint ? diffRead : diffReadFor(group.files);
  const groupModel = (isTaint || group.findings.some((f) => escDirectSev.has(f.severity))) ? verifyModel : firstModel;
  return agent(
    `${gDiffRead} ${focus}\n\nAdversarially REFUTE EACH of these ${payload.length} finding(s) INDEPENDENTLY by reading the real code path around each file:line. Return one verdict per finding, keyed by its "id" (copy the id verbatim; one verdict object per finding). Findings: ${JSON.stringify(payload)}.`,
    { agentType: pluginAgent(group.verifier), model: groupModel, label: `verify:${group.verifier}:${group.files[0] ?? 'multi'}×${payload.length}`, phase: 'Verify', schema: VERDICTS_SCHEMA },
  ).then((r) => { bump(group.verifier); for (const v of (r?.verdicts ?? [])) if (v?.id) verdictByKey.set(v.id, { verdict: v.verdict, lens: v.lens }); })
    .catch((e) => { notes.push(`verify group [${group.files.join(', ') || group.verifier}] failed: ${e.message}`); for (const p of payload) verdictByKey.set(p.id, { verdict: 'uncertain', lens: 'error' }); });
};

// +1 opus REVERIFY guard (the "N+1" agent). The batched refuters bias toward "refuted"; a wrongly
// refuted HOT finding is the costly miss. ONE extra opus agent re-examines only the refuted/uncertain
// findings that are hot or low-confidence, with the bias INVERTED — uphold as "real" unless the
// refutation clearly holds on the changed lines. Corrected verdicts overwrite the first pass. Skipped
// when nothing qualifies. Bounded input (only the at-risk subset), one agent.
const reverifyGuard = async (findings, verdictByKey) => {
  const atRisk = findings.filter((f) => {
    const v = verdictByKey.get(findingKey(f));
    if (!v || v.verdict === 'real') return false;   // only re-check what a refuter killed / left unsure
    return HOT_SEVERITIES.includes(f.severity) || (f.confidence ?? 0) < policy.reportConfidence || f.uncertain === true;
  });
  if (!atRisk.length) return findings;
  // Route the reverify pass by the SAME rule that chose the first-pass verifier (verifierFor): a D3
  // finding under taint discovery gets the taint-verifier again — a generic re-read is the wrong
  // adversary for a cross-file taint claim. `.verifier` isn't preserved on `findings` (only the
  // selected-for-verification subset carries it before grouping), so re-derive from `.dimension`.
  const isTaintFinding = (f) => f.dimension === 'D3' && plan.discovery?.taint;
  const groups = [
    { verifierAgent: 'taint-verifier', items: atRisk.filter(isTaintFinding) },
    { verifierAgent: 'finding-verifier', items: atRisk.filter((f) => !isTaintFinding(f)) },
  ].filter((g) => g.items.length);
  const results = await parallel(groups.map((g) => () => {
    const payload = g.items.map((f) => ({ ...verifyPayload(f), priorVerdict: verdictByKey.get(findingKey(f)).verdict }));
    return agent(
      `A first verification pass REFUTED or left UNCERTAIN the finding(s) below — these are the ones most costly to MISS. Re-examine EACH for a FALSE NEGATIVE. For THIS pass invert the usual bias: uphold a finding as "real" unless the refutation clearly holds on the CHANGED lines (cite the concrete failing path); otherwise keep "refuted"/"uncertain". Return one verdict per finding, keyed by its "id". ${diffRead}\n\nFindings (with the prior verdict): ${JSON.stringify(payload)}.`,
      { agentType: pluginAgent(g.verifierAgent), model: verifyModel, label: `reverify:${g.verifierAgent}×${g.items.length}`, phase: 'Verify', schema: VERDICTS_SCHEMA },
    ).then((res) => (bump(g.verifierAgent), res)).catch((e) => { notes.push(`reverify guard (${g.verifierAgent}) failed: ${e.message}`); return null; });
  }));
  const corrected = new Map();
  for (const r of results) for (const v of (r?.verdicts ?? [])) if (v?.id) corrected.set(v.id, { verdict: v.verdict, lens: v.lens });
  if (!corrected.size) return findings;
  return findings.map((f) => corrected.has(findingKey(f)) ? { ...f, verdict: corrected.get(findingKey(f)) } : f);
};

// Verify a finding set within a group budget: SELECT the unsure (selectForVerification), tag each with
// its verifier lens, GROUP into ≤budget groups, refute in parallel, apply verdicts, then (main pass
// only) run the +1 reverify guard. Returns findings with `.verdict` attached on the verified ones; the
// rest pass through untouched so resolveVerification([]) keeps them (trusted, confident findings).
const verifyFindings = async (findings, { budget, reverify }) => {
  if (!plan.runVerify || !findings.length) return findings;
  const selKeys = new Set(selectForVerification(findings, policy, { riskPaths }).map(findingKey));
  const tagged = findings.filter((f) => selKeys.has(findingKey(f))).map((f) => ({ ...f, verifier: verifierFor(f) }));
  if (!tagged.length) return findings;
  const verdictByKey = new Map();
  await parallel(groupForVerification(tagged, budget).map((g) => () => spawnBatchVerifier(g, verdictByKey)));
  const verified = findings.map((f) => verdictByKey.has(findingKey(f)) ? { ...f, verdict: verdictByKey.get(findingKey(f)) } : f);
  return reverify ? reverifyGuard(verified, verdictByKey) : verified;
};

// Re-dispatch a bounded, pre-capped (selectGaps) set of completeness gaps — shared by the exhaustive
// critic (≤6) and the high-tier screen (≤2). Each gap's named agent re-reviews with the full diff;
// only genuinely NEW findings (ledger-deduped against allFindings AT CALL TIME) survive and re-enter
// the batched Verify (own group budget, no reverify guard — the gap set is already tiny). Returns the
// verified-fresh findings for the caller to concat. Advisory — proposes, never edits.
async function reDispatchGaps(gaps, tag) {
  if (!gaps.length) return [];
  const seen = new Set(allFindings.map(findingKey));
  const reDispatched = await parallel(gaps.map((g) => () =>
    agent(
      `${packBlock}` +
      `Targeted re-review for a coverage gap (${g.kind}). Focus: ${g.dispatch.focus ?? g.what ?? ''}. Files: ${JSON.stringify(g.dispatch.files ?? [])}. ` +
      `Acceptance criteria: ${JSON.stringify(briefFor(g.dispatch.agent, brief))}. Project rules: ${JSON.stringify(plan.projectRules)}. ${diffReadFor(g.dispatch.files)}`,
      // model PINNED to sonnet (see intent note): gap re-dispatch is a reviewer pass, not orchestration —
      // un-pinned it inherited the session model (opus). diffReadFor slices to the gap's files.
      { agentType: pluginAgent(g.dispatch.agent), model: 'sonnet', label: `gap:${g.kind}`, phase: 'Review', schema: FINDINGS_SCHEMA },
    ).then((r) => { bump(g.dispatch.agent); return r?.findings ?? []; })
      .catch((e) => { notes.push(`${tag} re-dispatch ${g.kind} failed: ${e.message}`); return []; })));
  const fresh = reDispatched.flat().filter((f) => !seen.has(findingKey(f)));
  return verifyFindings(fresh, { budget: policy.maxVerifierAgents, reverify: false });
}

// ONE review pass over an aspect. Prompt ordering is deliberate for prompt-cache reuse: the shared,
// byte-identical blocks (intent brief + project rules) lead so they cache across every aspect of the
// same reviewer agent; the per-aspect bits (shard diff, then the dim + file list) trail so they never
// poison that prefix. `pass` (1|2) tags the S7.1 double-run passes in the label; 0 = a single
// (non-exhaustive) run and adds no suffix. Returns raw {findings,strengths}, null on fail.
// An aspect now covers one AGENT's full dim set (a.dims). All dims sharing an agent share a model
// (the OPUS_DIMS D3/D7/D9 are each a distinct single-dim agent), so the group's model is the first
// resolved one. dimList drives the prompt; the label carries BOTH the dim codes and the reviewer's
// name (one agent per aspect) so users read "review:D6+D8:data-store-reviewer:all".
const reviewOnce = (a, pass) => {
  const dimList = (a.dims ?? []).join(', ');
  const dimTag = (a.dims ?? []).join('+');
  const model = (a.dims ?? []).map((d) => plan.models?.[d]).find(Boolean);
  return agent(
  `${reviewBlock}` +
  `${packBlock}` +
  `${doctrineFor(a.agent)}` +
  `${knownFPBlock}` +
  // briefFor: the criteria/mismatch/scrutinize payload only reaches the two reviewers whose
  // instructions act on it; the rest get the one-line summary (see CRITERIA_AGENTS above).
  `Acceptance criteria, mismatches + flagged intent groups (groups marked scrutinize warrant extra attention): ${JSON.stringify(briefFor(a.agent, brief))}. ` +
  `Project rules: ${JSON.stringify(plan.projectRules)}. ` +
  // The 4-call budget covers Bash too. Reviewers now HAVE Bash (read-only: a PreToolUse allowlist in
  // lib/allow-bash.mjs denies anything that could write), which is what lets a reviewer pull the one
  // fact it is missing — `git log` on a suspect file, an `rg` for a caller — instead of the pipeline
  // pre-computing a pack for every run. Keeping it inside the SAME budget is deliberate: pull-on-demand
  // only beats push-everything while the pulls stay bounded.
  `The CONTEXT PACK above carries the enclosing definitions, imports, and in-repo callers — use it FIRST. Make at most 4 additional lookups (Read, Grep, or read-only Bash — git show/log/diff/blame, rg, grep, sed -n; writes are blocked), only when the pack is insufficient for a specific suspected finding (name the suspicion in the finding's evidence); never read outside the changed files' directories except a directly named import.\n` +
  // COST LEVER (slicing): a reviewer reads only its files' diff slices; D3 (security) keeps the FULL
  // diff so cross-file taint source→sink survives (the aspect is unsharded over all files anyway).
  // COST LEVER (manifests): the scope is a PATH to a "<file>\t<slice>" listing rather than an inlined
  // array, so args carries one line per shard instead of one per file. Falls back to the inline list
  // for the small aspects that still carry one (scrutiny targets) or when no manifest was written.
  `${scopeFor(a, dimList)}` +
  // S6.2/S6.3/S6.4: per-reviewer extras — correctness gets the cross-file consequence directive
  // + bug-history prior; test-adequacy gets the executed-test signal; others get ''.
  reviewerAddendum(a.agent, { historyPath, testSignal }),
  { agentType: pluginAgent(a.agent), model, label: `review:${dimTag}:${a.agent}:${a.shardId}${pass ? `#${pass}` : ''}`, phase: 'Review', schema: FINDINGS_SCHEMA },
  ).then((r) => { bump(a.agent); return { findings: r?.findings ?? [], strengths: r?.strengths ?? [] }; })
    .catch((e) => { notes.push(`review ${dimTag}:${a.agent}/${a.shardId}${pass ? ` pass ${pass}` : ''} failed: ${e.message}`); return null; });
};

// S7.1: in exhaustive mode the correctness + vuln reviewers (the highest cost-of-miss) run TWICE — two
// INDEPENDENT passes unioned + deduped by findingKey (dedupeFindings), so a finding both passes agree
// on is verified once, not twice. Both passes bump the run count, so "Agents & coverage" shows the
// doubled dispatch. A failed pass degrades to nothing (never crashes the run).
const doubleRun = plan.discovery?.doubleRun === true;

// ONE review pass over an aspect (with the S7.1 double-run for the two highest cost-of-miss agents).
const reviewAspect = async (a) => {
  if (!(doubleRun && isDoubleRunAgent(a.agent))) {
    const r = await reviewOnce(a, 0);
    return r ? { aspect: a, findings: r.findings, strengths: r.strengths } : null;
  }
  const passes = await parallel([() => reviewOnce(a, 1), () => reviewOnce(a, 2)]);
  if (passes.every((p) => !p)) return null;
  return {
    aspect: a,
    findings: dedupeFindings(passes.flatMap((p) => p?.findings ?? [])),
    strengths: passes.flatMap((p) => p?.strengths ?? []),
  };
};

// Review is a BARRIER (parallel, not the old per-aspect pipeline): batched Verify needs EVERY finding
// at once to group by (lens, file) and cap agent count GLOBALLY — verifying per-aspect could not bound
// the total. Wall-clock cost is small (the review fan-out finishes close together; verify is a short
// tail). This is the legit barrier case: a global select/group/cap across the full result set.
const reviewed = await parallel(aspects.map((a) => () => reviewAspect(a)));
let allFindings = reviewed.filter(Boolean).flatMap((r) => r.findings);
const allStrengths = reviewed.filter(Boolean).flatMap((r) => r.strengths ?? []);

// Batched verification over the full finding set: ≤ maxVerifierAgents sonnet-first groups (opus for a
// critical group + taint) + 1 opus reverify guard.
phase('Verify');
allFindings = await verifyFindings(allFindings, { budget: policy.maxVerifierAgents, reverify: true });

// ---------------------------------------------------------------- Tier C: completeness-critic (false-negative guard)
// Exhaustive (high/critical) reviews only. One bounded pass hunts for what the fan-out MISSED;
// each gap's named agent is re-dispatched (≤6), ledger-gated so only genuinely new findings are
// added, and those re-enter Verify before Resolve/Synthesize. Advisory — proposes, never edits.
// Whitelist of REAL re-dispatch targets = the full bundled reviewer universe (values of the
// DIMENSION_AGENTS map, passed in as plan.dimensionAgentsAll). Gaps naming anything else (a critic
// hallucination like "intent-verifier") are dropped by selectGaps before reDispatchGaps ever runs.
// null when the map is somehow absent → no name check (never blocks all re-dispatch).
const gapWhitelist = (() => { const a = [...new Set(Object.values(plan.dimensionAgentsAll ?? {}))]; return a.length ? a : null; })();
if (plan.discovery?.completenessCritic) {
  // Digest, not the full findings: the critic checks WHICH criteria/dimensions have a finding and
  // whether an asserted claim was verified — it never re-reads the prose evidence/fix. Keep verdict
  // (its unverified-claim gate) + dimension (missing-dimension gate); drop evidence/fix (the bulky
  // fields). Full evidence/fix still reach the synthesizer via resolved.report — no traceability loss.
  const findingsDigest = allFindings.map((f) => ({
    file: f.file, line: f.line, title: f.title, dimension: f.dimension,
    severity: f.severity, confidence: f.confidence, verdict: f.verdict,
  }));
  const critic = await agent(
    `${reviewBlock}` +
    `Hunt for what this review MISSED — do NOT re-review everything. Dimensions that ran: ${JSON.stringify([...(plan.dimensions ?? []), ...triageExtraDims])}. ` +
    // criticIntent: the gap-kind-bearing fields only; the per-group file lists are dropped because
    // this critic gets the full diff + the changed-file manifest on the next line anyway.
    `Acceptance criteria + coverage: ${JSON.stringify(criticIntent(intent))}. Kept findings: ${JSON.stringify(findingsDigest)}. ` +
    `Risk paths: ${JSON.stringify(plan.signals?.riskPaths ?? [])}. Project rules: ${JSON.stringify(plan.projectRules)}. ` +
    `${fileListRef} Diff summary: ${plan.diffSummary}. ${diffRead}`,
    { agentType: pluginAgent('completeness-critic'), model: 'opus', label: 'completeness-critic', phase: 'Verify', schema: GAPS_SCHEMA },
  ).then((r) => (bump('completeness-critic'), r)).catch((e) => { notes.push(`completeness-critic failed: ${e.message}`); return null; });

  if (critic?.assessment) notes.push(`completeness-critic: ${critic.assessment}`);
  allFindings = allFindings.concat(await reDispatchGaps(selectGaps(critic?.gaps, 6, gapWhitelist), 'completeness'));
}

// ---------------------------------------------------------------- Tier B: completeness SCREEN (every workflow tier, cheap)
// S6.1 of plan.md. A CHEAP x1 false-negative screen on EVERY workflow tier (low/standard/high) —
// sonnet, no diff — run only when the full exhaustive critic above did NOT (they never both run; the
// critic supersedes it at critical/--exhaustive). It sees coverage metadata ONLY — which dimensions
// ran, the finding titles, and the raw intent-analyzer output — but NO diff, so it flags
// dimension/criterion COVERAGE gaps and CANNOT claim untraced-taint. A gap naming an unrun dimension
// re-dispatches a per-tier-capped set of targeted reviewers (screenGapCap: low 0 / standard 1 / high 2,
// vs the exhaustive critic's 6), whose new findings re-enter Verify. Advisory — proposes, never edits.
if (plan.discovery?.completenessScreen) {
  const packet = screenPacket({ plan, findings: allFindings, intent, extraDims: triageExtraDims });
  const screen = await agent(
    `Coverage SCREEN (mode: screen) — you see NO diff, only coverage metadata. Flag at most 3 dimension/criterion COVERAGE gaps: an acceptance criterion with no matching finding, or a dimension that should have run but did not. Do NOT claim untraced-taint or any diff-level gap. ${JSON.stringify(packet)}`,
    { agentType: pluginAgent('completeness-critic'), model: 'sonnet', label: 'completeness-screen', phase: 'Verify', schema: GAPS_SCHEMA },
  ).then((r) => (bump('completeness-critic'), r)).catch((e) => { notes.push(`completeness-screen failed: ${e.message}`); return null; });

  if (screen?.assessment) notes.push(`completeness-screen: ${screen.assessment}`);
  // Gap re-dispatch budget follows blast radius (plan.discovery.screenGapCap): low=0 (sonnet screen
  // only, no re-dispatch), standard=1, high=2. cap 0 → selectGaps returns [] → reDispatchGaps no-ops.
  allFindings = allFindings.concat(await reDispatchGaps(selectGaps(screen?.gaps, plan.discovery?.screenGapCap ?? 0, gapWhitelist), 'completeness-screen'));
}

// ---------------------------------------------------------------- Resolve (deterministic, inline — no agent)
// Pure verdict resolution: run it here instead of spawning an executor agent. Verdicts are
// kept as { verdict, lens } only (matching the previous executor input) so behavior is identical.
phase('Synthesize');
let resolved;
try {
  const resolvedList = allFindings.map((f) => resolveVerification(f, f.verdict ? [{ verdict: f.verdict.verdict, lens: f.verdict.lens }] : [], policy));
  const part = partition(resolvedList, policy);
  resolved = { ...part, summary: `verified ${resolvedList.filter((f) => f.verify?.passes > 1).length} finding(s): ${part.report.length} kept, ${part.dropped.length} refuted, ${part.needsHuman.length} need human (cap ${policy.maxPassesPerAspect} looks/aspect)` };
} catch (e) {
  notes.push(`resolve failed: ${e.message}`);
  resolved = { report: allFindings, dropped: [], needsHuman: [], summary: {} };
}

// ---------------------------------------------------------------- Synthesize
const synth = await agent(
  `Aggregate into one deduped, severity-ranked review with a per-criterion traceability matrix. ` +
  // synthIntent: criteria + mismatches + summary. openQuestions stays its own labelled term below
  // (previously it also rode inside the full intent object, so it was sent twice).
  `Acceptance criteria: ${JSON.stringify(synthIntent(intent))}. Kept findings: ${JSON.stringify(resolved.report)}. ` +
  `Strengths seen: ${JSON.stringify(allStrengths)}. Business-logic open questions: ${JSON.stringify(intent?.openQuestions ?? [])}.`,
  // model PINNED to sonnet (see intent note): un-pinned it inherits the session model → opus.
  { agentType: pluginAgent('review-synthesizer'), model: 'sonnet', phase: 'Synthesize', schema: SYNTH_SCHEMA },
).then((r) => (bump('review-synthesizer'), r));

// Inline PR comments are built + posted deterministically by lib/comments.mjs from the
// command (step 5) when --comment is set; no agent pass is needed here.

// ---------------------------------------------------------------- Report payload (rendered by the COMMAND)
// No executor agent here: the workflow sandbox can't write files, and broadcasting this whole
// payload to a sonnet agent that only shells out to report.mjs is pure input-token waste. Assemble
// the payload and hand it back; /review step 5 runs `node report.mjs` directly (it reads
// {folderPath, verdict} from stdout). report.mjs still enforces the plan/agentRuns invariant.
// Diff-scope demotion: split the synthesized findings into in-diff (gate-affecting) and
// out-of-diff (advisory-only). Only the in-diff set feeds the verdict/gate/comments; the
// demoted set is rendered in its own "Out-of-scope observations" section (S1.1 of plan.md).
// build-args keys the changed-line ranges by SLICE NAME (short, derived) so args carries no copy of
// the reviewed path list at all. Rebuild the path-keyed index partitionByScope expects from the
// FINDINGS' own paths: inDiffScope only ever looks up a file it has a finding for, so an index built
// over exactly those paths is equivalent to one built over every reviewed file — a path with no
// diffRanges entry is absent either way, and absent still means "demote". `diffIndex` is non-null ONLY
// in the slice-name-collision fallback, where build-args sent the legacy path-keyed form directly.
const scopeIndex = diffIndex ?? Object.fromEntries((synth.findings ?? [])
  .map((f) => normPath(f?.file))
  .filter(Boolean)
  .map((p) => [p, (diffRanges ?? {})[sliceName(p)]])
  .filter(([, ranges]) => ranges !== undefined));
const { inScope: scopedFindings, outOfDiff } = partitionByScope(synth.findings ?? [], scopeIndex, plan.diffScope?.slack ?? 3);
if (outOfDiff.length) notes.push(`${outOfDiff.length} finding(s) anchored outside the change — demoted to advisory (not gated)`);

const payload = {
  findings: scopedFindings,
  outOfDiff,
  criteria: synth.criteria ?? [],
  tier: plan.tier, gate: plan.gate,
  needsHuman: [...(synth.needsHuman ?? []), ...(resolved.needsHuman ?? [])],
  skipped: synth.skipped ?? [], strengths: synth.strengths ?? [],
  summary: synth.summary ?? '', summaryPoints: synth.summaryPoints ?? [],
  context: { pr: bundle?.pr, tickets: bundle?.tickets, existingComments: bundle?.existingComments, trackerUsage: bundle?.trackerUsage },
  verify: resolved.summary ?? {},
  plan, agentRuns,
  commentMode: flags?.comment === true,
  // S9: incremental review — signals report.mjs to dedupe findings against the previous run's
  // last-review.json (new-vs-carried-over) and re-key the sha-keyed state. Diff narrowing itself
  // happens deterministically in plan.mjs (prevHead..head, fail-open on non-fast-forward).
  incremental: flags?.incremental === true,
  startedAt: startedAt ?? null, prNumber: prNumber ?? null, checkout: checkout ?? null,
  testSignal: testSignal ?? null,   // S6.4: executed-test signal → report header (null unless --run-tests)
  contextPackStats: contextPackStats ?? null,   // WS7 S3: pack size/per-section counts → report's Agents & coverage section
  learningStore: plan.learning?.store ?? null, range: plan.range ?? null,
};

return { payload, needsHuman: payload.needsHuman, notes };
