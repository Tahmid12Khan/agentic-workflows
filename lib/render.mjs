import { DIMENSION_AGENTS, DIMENSION_LABELS } from './triage.mjs';

const SEV_ORDER = ['critical', 'high', 'important', 'minor', 'suggestion'];
const MIN_CONFIDENCE = 80;

// --- agent coverage: who ran, who didn't, and why ---
// Pure: derive the agent run-down from the deterministic plan (plan.mjs output)
// plus an optional `runs` map (agentName → actual dispatch count the orchestrator
// observed, which captures shard fan-out, spawn-on-doubt, and verifier passes).
// Encodes the dispatch rules from commands/review.md so the report can state what
// happened without trusting the model's memory.
const dimLabel = (d, labels) => `${d} ${labels[d] ?? DIMENSION_LABELS[d] ?? ''}`.trim();

function reviewerRows(plan) {
  const planned = new Set(plan.dimensions ?? []);
  const labels = plan.dimensionLabels ?? {};
  const models = plan.models ?? {};
  const shards = plan.sharded ? (plan.shards?.length ?? 1) : 1;
  const byAgent = new Map();
  for (const [dim, agent] of Object.entries(DIMENSION_AGENTS)) {
    if (!byAgent.has(agent)) byAgent.set(agent, []);
    byAgent.get(agent).push(dim);
  }
  const rows = [];
  for (const [name, allDims] of byAgent) {
    const dims = allDims.filter(d => planned.has(d));
    const ran = dims.length > 0;
    rows.push({
      name,
      kind: 'reviewer',
      ran,
      model: ran ? (models[dims[0]] ?? '—') : '—',
      covers: (ran ? dims : allDims).map(d => dimLabel(d, labels)).join(', '),
      plannedRuns: ran ? dims.length * shards : 0,
      reason: ran
        ? `reviewed ${dims.map(d => dimLabel(d, labels)).join(', ')}${shards > 1 ? ` across ${shards} shards` : ''}`
        : `no ${allDims.map(d => dimLabel(d, labels)).join(' / ')} dimension was triggered for this change`,
    });
  }
  return rows;
}

function pipelineRows(plan) {
  const tier = plan.tier ?? 'standard';
  const trivial = tier === 'trivial';
  const belowStandard = trivial || tier === 'low';
  const d = plan.discovery ?? {};
  // Verifiers escalate cheap→strong (lib/verify.mjs); reflect the actual pair, not a flat "opus".
  const vmodel = `${plan.verify?.modelFirst ?? 'sonnet'}→${plan.verify?.modelEscalate ?? 'opus'}`;
  const mk = (name, model, role, ran, reason) => ({ name, kind: 'pipeline', model, covers: role, ran, plannedRuns: ran ? 1 : 0, reason });
  return [
    mk('triage-classifier', 'haiku', 'tier sanity-check', !trivial, trivial ? 'skipped — trivial change reviewed inline' : 'confirmed/raised the tier and added missed dimensions'),
    mk('intent-harvester', 'sonnet', 'stated vs derived intent', !trivial, trivial ? 'skipped — a trivial change is reviewed inline' : 'built the acceptance-criteria model'),
    mk('intent-grouper', 'sonnet', 'primary vs extra intents', !trivial, trivial ? 'skipped — trivial change' : 'split primary from extra/unexplained changes'),
    mk('business-logic-analyzer', 'sonnet', 'domain logic + open questions', !belowStandard, belowStandard ? `skipped — runs at standard tier and above (tier: ${tier})` : 'modelled domain logic and surfaced open questions'),
    mk('finding-verifier', vmodel, 'adversarial refute of unsure findings', !!plan.runVerify, plan.runVerify ? 'bounded adversarial verification (high/critical); critical findings go straight to the strong model' : `skipped — verification runs at high/critical (tier: ${tier})`),
    mk('taint-verifier', vmodel, 'data-flow security verify (D3)', !!d.taint, d.taint ? 'exhaustive taint pass on security findings' : 'skipped — exhaustive (Tier C) only'),
    mk('completeness-critic', 'opus', 'false-negative guard', !!d.completenessCritic, d.completenessCritic ? 'exhaustive completeness sweep' : 'skipped — exhaustive (Tier C) only'),
    mk('review-synthesizer', 'sonnet', 'dedupe, traceability, verdict', !trivial, trivial ? 'skipped — trivial change reviewed inline' : 'deduped findings and built this report'),
  ];
}

export function agentCoverage(plan = {}, runs = {}) {
  const tier = plan.tier ?? 'standard';
  // Whether the orchestrator handed us real dispatch counts. When it did (any non-empty
  // map), those counts are authoritative and COMPLETE — every dispatched agent is counted —
  // so an agent the plan expected but that has no entry dispatched 0 times. RAN must then
  // follow the observed count, never the planned `r.ran` flag: otherwise a planned-but-never
  // -dispatched agent shows up under "ran … 0×" (or a phantom "ran 1×" via the planned
  // fallback). Only when NO counts were observed (the trivial inline path passes `{}`) do we
  // fall back to the plan's expectation.
  const observed = !!runs && Object.keys(runs).length > 0;
  const rows = [...pipelineRows(plan), ...reviewerRows(plan)].map(r => {
    const count = observed ? (runs[r.name] ?? 0) : r.plannedRuns;
    const didRun = observed ? count > 0 : r.ran;
    const reason = (observed && r.ran && count === 0)
      ? 'planned for this change but no dispatch was recorded (spawn failed or gated out at runtime)'
      : r.reason;
    return { ...r, runs: count, ran: didRun, reason };
  });
  const ran = rows.filter(r => r.ran);
  const notRun = rows.filter(r => !r.ran);
  const dispatches = ran.reduce((n, r) => n + (r.runs || 0), 0);
  return {
    tier,
    trivialInline: tier === 'trivial',
    ran,
    notRun,
    total: rows.length,
    ranCount: ran.length,
    dispatches,
  };
}

export function renderVerdict(findings, gate) {
  const present = new Set(findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE).map(f => f.severity));
  const blocks = (gate.block_on ?? ['critical']).some(s => present.has(s));
  const warns = (gate.warn_on ?? ['high']).some(s => present.has(s));
  if (blocks) return { verdict: 'BLOCK', exitCode: 1 };
  if (warns) return { verdict: 'WARN', exitCode: 0 };
  return { verdict: 'APPROVE', exitCode: 0 };
}

// An open-question / needs-human item may arrive as a plain string or as an object
// with any of several text fields — never render an empty card.
function humanText(f) {
  if (typeof f === 'string') return f || '(unspecified)';
  if (f && typeof f === 'object') return f.question || f.title || f.text || f.summary || '(unspecified — see context)';
  return '(unspecified)';
}

function metaBits(meta) {
  if (!meta) return [];
  const b = [];
  if (meta.prNumber) b.push(`PR #${meta.prNumber}`);
  if (meta.started) b.push(`started ${meta.started}`);
  if (meta.finished) b.push(`${meta.started ? 'finished' : 'generated'} ${meta.finished}`);
  if (meta.duration) b.push(`took ${meta.duration}`);
  return b;
}

// State, per enabled tracker, whether it was actually used (via MCP) this run.
// Off trackers are omitted; enabled ones always appear so the report is explicit.
const TRACKER_NAMES = { clickup: 'ClickUp', jira: 'Jira' };
const TRACKER_STATUS = {
  used: 'used',
  'skipped-no-mcp': 'skipped — MCP server not connected',
  'no-keys': 'enabled — no ticket keys in PR/commits',
  off: 'off',
};
function trackerLines(usage = {}) {
  const out = [];
  for (const k of ['clickup', 'jira']) {
    const u = usage?.[k];
    if (!u || u.status === 'off') continue;
    const label = TRACKER_STATUS[u.status] ?? u.status;
    out.push(`${TRACKER_NAMES[k] ?? k}: ${label}${u.detail ? ` (${u.detail})` : ''}`);
  }
  return out;
}

// One line naming exactly what was checked out for the review: the head ref HEAD was
// detached onto, the base it was diffed against, and the head sha — so the report records
// the precise code reviewed. Returns [] when the review ran in place (no checkout).
function checkoutLine(checkout) {
  if (!checkout || !checkout.headRef) return [];
  const base = checkout.baseRef ? ` vs ${checkout.baseRef}` : '';
  const at = checkout.sha ? ` @ ${String(checkout.sha).slice(0, 8)}` : '';
  return [`${checkout.headRef}${base}${at}`];
}

export function renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, summaryPoints, context, verify, learnings, coverage, meta, checkout = null }) {
  const kept = (findings ?? []).filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const lines = [`# Code Review — ${tier}`, ''];
  const mb = metaBits(meta);
  if (mb.length) lines.push(`_${mb.join(' · ')}_`, '');

  if (summary) lines.push(summary, '');
  // Headline above; scannable bullets below. The synthesizer emits both — a 1-line verdict and the
  // 3-6 points behind it — so the report leads with a scannable list instead of one wall paragraph.
  if (summaryPoints?.length) {
    for (const p of summaryPoints) lines.push(`- ${p}`);
    lines.push('');
  }
  if (strengths?.length) {
    lines.push('## Strengths', '');
    for (const s of strengths) lines.push(`- ${s}`);
    lines.push('');
  }

  lines.push('## Requirement traceability', '');
  if (!(criteria ?? []).length) lines.push('_No acceptance criteria were captured for this change._', '');
  for (const c of criteria ?? []) {
    const name = c.name || c.text || c.id;          // lead with the requirement, not the bare id
    const tag = (c.name || c.text) ? ` \`${c.id}\`` : '';
    const status = c.covered ? (c.evidence ? `covered — _${c.evidence}_` : 'covered') : '**not covered**';
    lines.push(`- [${c.covered ? 'x' : ' '}] **${name}**${tag} — ${status}`);
  }
  lines.push('');

  for (const sev of SEV_ORDER) {
    const group = kept.filter(f => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${cap(sev)}`, '');
    for (const f of group) {
      // "verified" only when a verifier actually looked (passes > 1). passes === 1 / no verify block =
      // trusted on reviewer confidence (≥80, off risk paths) per the selectForVerification cost policy —
      // label it so an absent "verified" tag is never ambiguous (it isn't a missing check, it's a skipped one).
      const vtag = (f.verify && f.verify.passes > 1) ? `verified ×${f.verify.passes}` : 'trusted';
      const tags = [f.dimension, f.recurring ? 'recurring' : null, vtag].filter(Boolean).join(' · ');
      lines.push(`- **${f.title}** (${tags}) — \`${f.file}:${f.line}\` _(conf ${f.confidence})_`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    }
    lines.push('');
  }

  if (needsHuman?.length) {
    lines.push(`## Needs your input (${needsHuman.length})`, '', 'Re-checked to the cap and still split — your call.', '');
    for (const f of needsHuman) {
      const q = humanText(f);
      const loc = (f && typeof f === 'object' && f.file) ? ` — \`${f.file}${f.line ? ':' + f.line : ''}\`` : '';
      lines.push(`- **${q}**${loc}`);
      if (f && typeof f === 'object') {
        if (f.evidence) lines.push(`  - ${f.evidence}`);
        if (f.verify) lines.push(`  - ${f.verify.passes}× looks · ${f.verify.real} real / ${f.verify.refuted} refuted`);
      }
    }
    lines.push('');
  }

  if (coverage) {
    lines.push('## Agents & coverage', '');
    lines.push(`${coverage.ranCount} of ${coverage.total} bundled agents ran, ${coverage.dispatches} dispatch(es) total (tier: ${coverage.tier}).`, '');
    if (coverage.trivialInline) lines.push('_Trivial change — reviewed in a single inline pass; no reviewer subagents were dispatched._', '');
    lines.push('### Ran', '');
    if (!coverage.ran.length) lines.push('- _none_');
    for (const a of coverage.ran) {
      lines.push(`- **${a.name}** (${a.model}, ${a.runs}×) — ${a.reason}`);
    }
    lines.push('', '### Did not run', '');
    if (!coverage.notRun.length) lines.push('- _none — every bundled agent ran_');
    for (const a of coverage.notRun) {
      lines.push(`- **${a.name}** — ${a.reason}`);
    }
    lines.push('');
  }

  if (skipped?.length) {
    lines.push('## Notes', '');
    for (const s of skipped) lines.push(`- ${s.dimension ? `**${s.dimension}** — ` : ''}${s.reason ?? s}`);
    lines.push('');
  }

  const trackers = trackerLines(context?.trackerUsage);
  const wlines = checkoutLine(checkout);
  if ((context && (context.pr || context.tickets?.length || context.existingComments?.length)) || trackers.length || wlines.length) {
    lines.push('## Context used', '');
    if (context?.pr) lines.push(`- PR: ${context.pr.title ?? '(untitled)'}`);
    for (const t of context?.tickets ?? []) lines.push(`- ${t.tracker ?? 'issue'} ${t.key}: ${t.title ?? ''}`);
    if (context?.existingComments?.length) lines.push(`- ${context.existingComments.length} existing PR comment(s) folded in`);
    for (const l of trackers) lines.push(`- Tracker ${l}`);
    for (const l of wlines) lines.push(`- Reviewed ${l}`);
    lines.push('');
  }

  const footer = [verify?.summary, learnings?.applied ? `memory: ${learnings.applied}` : null].filter(Boolean).join(' · ');
  if (footer) lines.push(`> ${footer}`, '');

  const { verdict } = renderVerdict(findings ?? [], { block_on: ['critical'], warn_on: ['high'] });
  lines.push(`## Verdict: ${verdict}`);
  return lines.join('\n');
}

// --- full self-contained HTML report ---
export function renderHtml(data) {
  const { findings = [], criteria = [], tier = 'standard', needsHuman = [], skipped = [], strengths = [], summary = '', summaryPoints = [], context = {}, verify = {}, coverage = null, meta = null, checkout = null, gate = { block_on: ['critical'], warn_on: ['high'] } } = data;
  const metaStr = metaBits(meta).join(' · ');
  const kept = findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const { verdict } = renderVerdict(findings, gate);
  const tColor = { trivial: '#4FB8A8', low: '#8FBF5A', standard: '#F0A92B', high: '#E8742E', critical: '#E23E4E' }[tier] || '#F0A92B';
  const vColor = { APPROVE: '#8FBF5A', WARN: '#F0A92B', BLOCK: '#E23E4E' }[verdict];
  const counts = SEV_ORDER.map(s => [s, kept.filter(f => f.severity === s).length]).filter(([, n]) => n);

  const sevBlock = SEV_ORDER.map(sev => {
    const g = kept.filter(f => f.severity === sev);
    if (!g.length) return '';
    return `<section class="grp"><h3 class="sev sev-${sev}">${cap(sev)} <span class="n">${g.length}</span></h3>` +
      g.map(f => `<article class="finding">
        <div class="f-head"><span class="f-title">${esc(f.title)}</span><span class="f-loc">${esc(f.file)}:${f.line ?? '?'}</span></div>
        <div class="f-meta">${esc(f.dimension || '')}${f.recurring ? ' · <b class="rec">recurring</b>' : ''}${(f.verify && f.verify.passes > 1) ? ` · <b class="ver">verified ×${f.verify.passes}</b> (${f.verify.real}✓/${f.verify.refuted}✗)` : ' · trusted'} · conf ${f.confidence ?? '—'}</div>
        ${f.evidence ? `<p class="f-ev"><b>evidence</b> ${esc(f.evidence)}</p>` : ''}
        ${f.fix ? `<p class="f-fix"><b>fix</b> ${esc(f.fix)}</p>` : ''}
      </article>`).join('') + `</section>`;
  }).join('');

  const human = needsHuman.length ? `<section class="grp needshuman"><h3>⚠ Needs your input <span class="n">${needsHuman.length}</span></h3>
    <p class="hint">Re-checked to the cap and still split — your call.</p>` +
    needsHuman.map(f => {
      const o = (f && typeof f === 'object') ? f : {};
      const loc = o.file ? `<span class="f-loc">${esc(o.file)}${o.line ? ':' + o.line : ''}</span>` : '';
      return `<article class="finding"><div class="f-head"><span class="f-title">${esc(humanText(f))}</span>${loc}</div>${o.evidence ? `<p class="f-ev">${esc(o.evidence)}</p>` : ''}${o.verify ? `<div class="f-meta">${o.verify.passes}× looks — ${o.verify.real} real / ${o.verify.refuted} refuted</div>` : ''}</article>`;
    }).join('') + `</section>` : '';

  const skip = skipped.length ? `<section class="grp">` +
    skipped.map(s => `<div class="skipline">${s.dimension ? `<b>${esc(s.dimension)}</b> — ` : ''}${esc(s.reason ?? String(s))}</div>`).join('') + `</section>` : '';

  const crit = (criteria || []).map(c => {
    const name = c.name || c.text || c.id;
    const tag = (c.name || c.text) ? ` <code>${esc(c.id)}</code>` : '';
    return `<li class="${c.covered ? 'ok' : 'no'}"><span class="box">${c.covered ? '✓' : '○'}</span><b>${esc(name)}</b>${tag}${c.evidence ? `<em>${esc(c.evidence)}</em>` : `<em>${c.covered ? '' : 'not covered'}</em>`}</li>`;
  }).join('');

  const covSection = coverage ? (() => {
    const row = a => `<div class="cov-row"><span class="cov-name">${esc(a.name)}</span><span class="cov-meta">${a.ran ? `${esc(a.model)} · ${a.runs}×` : 'not run'}</span><span class="cov-why">${esc(a.reason)}</span></div>`;
    const inline = coverage.trivialInline ? `<p class="hint">Trivial change — reviewed in a single inline pass; no reviewer subagents were dispatched.</p>` : '';
    return `<section class="cov">
      <p class="cov-sum">${coverage.ranCount} of ${coverage.total} bundled agents ran · ${coverage.dispatches} dispatch(es) · tier ${esc(coverage.tier)}</p>${inline}
      <div class="cov-grp"><h4 class="cov-h ran">Ran (${coverage.ran.length})</h4>${coverage.ran.map(row).join('') || '<div class="cov-row"><span class="cov-why">none</span></div>'}</div>
      <div class="cov-grp"><h4 class="cov-h off">Did not run (${coverage.notRun.length})</h4>${coverage.notRun.map(row).join('') || '<div class="cov-row"><span class="cov-why">none — every bundled agent ran</span></div>'}</div>
    </section>`;
  })() : '';

  const ctxItems = [];
  if (context.pr) ctxItems.push(`PR: ${esc(context.pr.title || 'untitled')}`);
  (context.tickets || []).forEach(t => ctxItems.push(`${esc(t.tracker || 'issue')} ${esc(t.key)}: ${esc(t.title || '')}`));
  if (context.existingComments?.length) ctxItems.push(`${context.existingComments.length} existing PR comment(s) folded in`);
  trackerLines(context.trackerUsage).forEach(l => ctxItems.push(`Tracker ${esc(l)}`));
  checkoutLine(checkout).forEach(l => ctxItems.push(`Reviewed ${esc(l)}`));

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Review — ${esc(tier)} · ${verdict}</title>
<style>
:root{--bg:#0C1618;--panel:#11201E;--line:#1F3A35;--text:#DCE6E1;--muted:#7E938C;--accent:#F0A92B;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;--sans:-apple-system,system-ui,"Segoe UI",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.6;font-size:17px}
.wrap{max-width:960px;margin:0 auto;padding:44px 24px 90px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:8px}
.badge{font-family:var(--mono);font-size:14px;font-weight:700;letter-spacing:.06em;padding:7px 13px;border-radius:7px;color:#0c1618}
h1{font-size:30px;font-weight:800;letter-spacing:-.02em;margin:0;flex:1 1 auto}
.meta{font-family:var(--mono);font-size:13.5px;color:var(--muted);margin:14px 0 0}
.sub{font-size:16.5px;color:var(--text);margin:14px 0 10px}
.sum{margin:0 0 26px;padding-left:22px}.sum li{margin:6px 0;font-size:16px;color:var(--text)}
.legend{font-family:var(--mono);font-size:12.5px;color:var(--muted);margin:-4px 0 16px}.legend .ver{color:#8FBF5A}
.f-meta .ver{color:#8FBF5A}
.counts{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 30px}
.pill{font-family:var(--mono);font-size:13px;border:1px solid var(--line);border-radius:6px;padding:5px 10px;color:var(--muted)}
h2{font-size:15px;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:36px 0 14px}
.trace{list-style:none;padding:0;margin:0}.trace li{display:flex;gap:10px;align-items:baseline;padding:9px 0;border-top:1px solid var(--line);font-size:16px}
.trace .box{font-family:var(--mono)}.trace .ok .box,.trace li.ok{color:var(--text)}.trace li.no{color:var(--muted)}.trace li.no .box{color:#E8742E}
.trace b{font-weight:700;font-size:16px}.trace code{font-family:var(--mono);font-size:13px;color:var(--muted)}.trace em{color:var(--muted);font-style:normal;margin-left:auto;font-family:var(--mono);font-size:13px}
.grp{margin:0 0 24px}.grp h3{font-size:18px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.grp .n{font-family:var(--mono);font-size:14px;color:var(--muted);font-weight:400}
.sev-critical{color:#E23E4E}.sev-high{color:#E8742E}.sev-important{color:#F0A92B}.sev-minor{color:#8FBF5A}.sev-suggestion{color:#4FB8A8}
.finding{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:9px;background:var(--panel);padding:15px 18px;margin-bottom:11px}
.f-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.f-title{font-weight:700;font-size:17px}.f-loc{font-family:var(--mono);font-size:14px;color:var(--muted)}
.f-meta{font-family:var(--mono);font-size:13px;color:var(--muted);margin:7px 0}.rec{color:var(--accent)}
.f-ev,.f-fix{font-size:15.5px;margin:7px 0 0;color:var(--muted)}.f-ev b,.f-fix b{font-family:var(--mono);font-size:12px;color:var(--text);margin-right:6px;text-transform:uppercase;letter-spacing:.06em}
.needshuman{border:1px solid #5a3a1e;border-radius:11px;padding:18px;background:rgba(240,169,43,.05)}.needshuman h3{color:var(--accent)}.hint{color:var(--muted);font-size:15px;margin:0 0 14px}
.skipline{font-family:var(--mono);font-size:14px;color:var(--muted);padding:6px 0}
.cov-sum{font-family:var(--mono);font-size:14px;color:var(--text);margin:0 0 14px}
.cov-grp{margin:0 0 18px}.cov-h{font-family:var(--mono);font-size:13px;letter-spacing:.1em;text-transform:uppercase;margin:0 0 7px}
.cov-h.ran{color:#8FBF5A}.cov-h.off{color:var(--muted)}
.cov-row{display:grid;grid-template-columns:220px 120px 1fr;gap:12px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line);font-size:15px}
.cov-name{font-family:var(--mono);font-size:14px;color:var(--text);word-break:break-all}.cov-meta{font-family:var(--mono);font-size:13px;color:var(--accent)}.cov-why{color:var(--muted)}
@media(max-width:600px){.cov-row{grid-template-columns:1fr;gap:2px}.cov-meta{color:var(--muted)}}
.ctx{font-family:var(--mono);font-size:14px;color:var(--muted)}.ctx div{padding:4px 0}
.foot{margin-top:42px;border-top:1px solid var(--line);padding-top:16px;font-family:var(--mono);font-size:13px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="top">
  <span class="badge" style="background:${tColor}">${esc(tier).toUpperCase()}</span>
  <h1>Code Review</h1>
  <span class="badge" style="background:${vColor}">${verdict}</span>
</div>
${metaStr ? `<div class="meta">${esc(metaStr)}</div>` : ''}
<div class="sub">${esc(summary || '')}</div>
${summaryPoints.length ? `<ul class="sum">${summaryPoints.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
<div class="counts">${counts.map(([s, n]) => `<span class="pill">${n} ${s}</span>`).join('') || '<span class="pill">no blocking findings</span>'}</div>
${strengths.length ? `<h2>Strengths</h2><ul class="trace">${strengths.map(s => `<li class="ok"><span class="box">+</span>${esc(s)}</li>`).join('')}</ul>` : ''}
<h2>Requirement traceability</h2><ul class="trace">${crit || '<li class="no"><span class="box">○</span>no acceptance criteria captured</li>'}</ul>
<h2>Findings</h2>${sevBlock ? `<p class="legend"><b class="ver">verified ×N</b> = adversarially re-checked · <b>trusted</b> = high-confidence (≥${MIN_CONFIDENCE}), not re-checked (cost policy)</p>${sevBlock}` : '<p class="ctx">No findings at or above the confidence floor.</p>'}
${human ? `<h2>Open questions</h2>${human}` : ''}
${covSection ? `<h2>Agents &amp; coverage</h2>${covSection}` : ''}
${skip ? `<h2>Notes</h2>${skip}` : ''}
${ctxItems.length ? `<h2>Context used</h2><div class="ctx">${ctxItems.map(c => `<div>› ${c}</div>`).join('')}</div>` : ''}
<div class="foot">adversarial-code-review · advisory, never edits code · ${verify.summary ? esc(verify.summary) : 'bounded adversarial verification'}</div>
</div></body></html>`;
}

const cap = s => s[0].toUpperCase() + s.slice(1);
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
