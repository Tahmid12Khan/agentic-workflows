const SEV_ORDER = ['critical', 'high', 'important', 'minor', 'suggestion'];
const MIN_CONFIDENCE = 80;

export function renderVerdict(findings, gate) {
  const present = new Set(findings.filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE).map(f => f.severity));
  const blocks = (gate.block_on ?? ['critical']).some(s => present.has(s));
  const warns = (gate.warn_on ?? ['high']).some(s => present.has(s));
  if (blocks) return { verdict: 'BLOCK', exitCode: 1 };
  if (warns) return { verdict: 'WARN', exitCode: 0 };
  return { verdict: 'APPROVE', exitCode: 0 };
}

export function renderReport({ findings, criteria, tier, needsHuman, skipped, strengths, summary, context, verify, learnings }) {
  const kept = (findings ?? []).filter(f => (f.confidence ?? 100) >= MIN_CONFIDENCE);
  const lines = [`# Code Review (tier: ${tier})`, ''];

  if (summary) lines.push(summary, '');
  if (strengths?.length) {
    lines.push('## Strengths', '');
    for (const s of strengths) lines.push(`- ${s}`);
    lines.push('');
  }

  lines.push('## Requirement Traceability', '');
  for (const c of criteria ?? []) {
    lines.push(`- [${c.covered ? 'x' : ' '}] **${c.id}** ${c.text}${c.evidence ? ` — _${c.evidence}_` : ''}`);
  }
  lines.push('');

  for (const sev of SEV_ORDER) {
    const group = kept.filter(f => f.severity === sev);
    if (!group.length) continue;
    lines.push(`## ${cap(sev)}`, '');
    for (const f of group) {
      const tags = [f.dimension, f.recurring ? 'recurring' : null, f.verify ? `verified ×${f.verify.passes}` : null].filter(Boolean).join(' · ');
      lines.push(`- **${f.title}** (${tags}) — \`${f.file}:${f.line}\` _(conf ${f.confidence})_`);
      if (f.evidence) lines.push(`  - evidence: ${f.evidence}`);
      if (f.fix) lines.push(`  - fix: ${f.fix}`);
    }
    lines.push('');
  }

  if (needsHuman?.length) {
    lines.push('## ⚠ Needs your input (unresolved after bounded verification)', '');
    for (const f of needsHuman) {
      lines.push(`- **${f.question ?? f.title}** — \`${f.file ?? '?'}${f.line ? ':' + f.line : ''}\``);
      if (f.evidence) lines.push(`  - context: ${f.evidence}`);
      if (f.verify) lines.push(`  - looked ${f.verify.passes}× — ${f.verify.real} real / ${f.verify.refuted} refuted, still split`);
    }
    lines.push('');
  }

  if (skipped?.length) {
    lines.push('## Skipped (not enough signal / tool unavailable)', '');
    for (const s of skipped) lines.push(`- ${s.dimension ? `**${s.dimension}** — ` : ''}${s.reason ?? s}`);
    lines.push('');
  }

  if (context && (context.pr || context.tickets?.length || context.existingComments?.length)) {
    lines.push('## Context used', '');
    if (context.pr) lines.push(`- PR: ${context.pr.title ?? '(untitled)'}`);
    for (const t of context.tickets ?? []) lines.push(`- ${t.tracker ?? 'issue'} ${t.key}: ${t.title ?? ''}`);
    if (context.existingComments?.length) lines.push(`- ${context.existingComments.length} existing PR comment(s) folded in`);
    lines.push('');
  }

  if (verify?.summary) lines.push(`> ${verify.summary}`, '');
  if (learnings?.applied) lines.push(`> Memory: ${learnings.applied}`, '');

  const { verdict } = renderVerdict(findings ?? [], { block_on: ['critical'], warn_on: ['high'] });
  lines.push(`## Verdict: ${verdict}`);
  return lines.join('\n');
}

// --- full self-contained HTML report ---
export function renderHtml(data) {
  const { findings = [], criteria = [], tier = 'standard', needsHuman = [], skipped = [], strengths = [], summary = '', context = {}, verify = {}, gate = { block_on: ['critical'], warn_on: ['high'] } } = data;
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
        <div class="f-meta">${esc(f.dimension || '')}${f.recurring ? ' · <b class="rec">recurring</b>' : ''}${f.verify ? ` · verified ×${f.verify.passes} (${f.verify.real}✓/${f.verify.refuted}✗)` : ''} · conf ${f.confidence ?? '—'}</div>
        ${f.evidence ? `<p class="f-ev"><b>evidence</b> ${esc(f.evidence)}</p>` : ''}
        ${f.fix ? `<p class="f-fix"><b>fix</b> ${esc(f.fix)}</p>` : ''}
      </article>`).join('') + `</section>`;
  }).join('');

  const human = needsHuman.length ? `<section class="grp needshuman"><h3>⚠ Needs your input <span class="n">${needsHuman.length}</span></h3>
    <p class="hint">Re-checked up to the bounded cap and still split. Not dropped — your call.</p>` +
    needsHuman.map(f => `<article class="finding"><div class="f-head"><span class="f-title">${esc(f.question ?? f.title)}</span><span class="f-loc">${esc(f.file || '?')}${f.line ? ':' + f.line : ''}</span></div>${f.evidence ? `<p class="f-ev">${esc(f.evidence)}</p>` : ''}${f.verify ? `<div class="f-meta">looked ${f.verify.passes}× — ${f.verify.real} real / ${f.verify.refuted} refuted</div>` : ''}</article>`).join('') + `</section>` : '';

  const skip = skipped.length ? `<section class="grp"><h3>Skipped <span class="n">${skipped.length}</span></h3>` +
    skipped.map(s => `<div class="skipline">${s.dimension ? `<b>${esc(s.dimension)}</b> — ` : ''}${esc(s.reason ?? String(s))}</div>`).join('') + `</section>` : '';

  const crit = (criteria || []).map(c => `<li class="${c.covered ? 'ok' : 'no'}"><span class="box">${c.covered ? '✓' : '○'}</span><b>${esc(c.id)}</b> ${esc(c.text)}${c.evidence ? `<em>${esc(c.evidence)}</em>` : ''}</li>`).join('');

  const ctxItems = [];
  if (context.pr) ctxItems.push(`PR: ${esc(context.pr.title || 'untitled')}`);
  (context.tickets || []).forEach(t => ctxItems.push(`${esc(t.tracker || 'issue')} ${esc(t.key)}: ${esc(t.title || '')}`));
  if (context.existingComments?.length) ctxItems.push(`${context.existingComments.length} existing PR comment(s) folded in`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Code Review — ${esc(tier)} · ${verdict}</title>
<style>
:root{--bg:#0C1618;--panel:#11201E;--line:#1F3A35;--text:#DCE6E1;--muted:#7E938C;--accent:#F0A92B;--mono:"SF Mono",ui-monospace,Menlo,Consolas,monospace;--sans:-apple-system,system-ui,"Segoe UI",Arial,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);line-height:1.55}
.wrap{max-width:920px;margin:0 auto;padding:40px 24px 80px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:14px;border-bottom:1px solid var(--line);padding-bottom:22px;margin-bottom:8px}
.badge{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.06em;padding:6px 12px;border-radius:7px;color:#0c1618}
.verdict{font-size:13px}
h1{font-size:24px;font-weight:800;letter-spacing:-.02em;margin:0;flex:1 1 auto}
.sub{font-family:var(--mono);font-size:12px;color:var(--muted);margin:14px 0 28px}
.counts{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 30px}
.pill{font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:6px;padding:4px 9px;color:var(--muted)}
h2{font-size:13px;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:34px 0 14px}
.trace{list-style:none;padding:0;margin:0}.trace li{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.trace .box{font-family:var(--mono)}.trace .ok .box,.trace li.ok{color:var(--text)}.trace li.no{color:var(--muted)}.trace li.no .box{color:#E8742E}
.trace b{font-family:var(--mono);font-size:12px}.trace em{color:var(--muted);font-style:normal;margin-left:auto;font-family:var(--mono);font-size:11px}
.grp{margin:0 0 22px}.grp h3{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.grp .n{font-family:var(--mono);font-size:12px;color:var(--muted);font-weight:400}
.sev-critical{color:#E23E4E}.sev-high{color:#E8742E}.sev-important{color:#F0A92B}.sev-minor{color:#8FBF5A}.sev-suggestion{color:#4FB8A8}
.finding{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:9px;background:var(--panel);padding:14px 16px;margin-bottom:10px}
.f-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}.f-title{font-weight:700}.f-loc{font-family:var(--mono);font-size:12px;color:var(--muted)}
.f-meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin:6px 0}.rec{color:var(--accent)}
.f-ev,.f-fix{font-size:13.5px;margin:6px 0 0;color:var(--muted)}.f-ev b,.f-fix b{font-family:var(--mono);font-size:11px;color:var(--text);margin-right:6px;text-transform:uppercase;letter-spacing:.06em}
.needshuman{border:1px solid #5a3a1e;border-radius:11px;padding:16px;background:rgba(240,169,43,.05)}.needshuman h3{color:var(--accent)}.hint{color:var(--muted);font-size:13px;margin:0 0 12px}
.skipline{font-family:var(--mono);font-size:12px;color:var(--muted);padding:5px 0}
.ctx{font-family:var(--mono);font-size:12px;color:var(--muted)}.ctx div{padding:4px 0}
.foot{margin-top:40px;border-top:1px solid var(--line);padding-top:16px;font-family:var(--mono);font-size:11px;color:var(--muted)}
</style></head><body><div class="wrap">
<div class="top">
  <span class="badge" style="background:${tColor}">${esc(tier).toUpperCase()}</span>
  <h1>Code Review</h1>
  <span class="badge" style="background:${vColor}">${verdict}</span>
</div>
<div class="sub">${esc(summary || '')}</div>
<div class="counts">${counts.map(([s, n]) => `<span class="pill">${n} ${s}</span>`).join('') || '<span class="pill">no blocking findings</span>'}</div>
${strengths.length ? `<h2>Strengths</h2><ul class="trace">${strengths.map(s => `<li class="ok"><span class="box">+</span>${esc(s)}</li>`).join('')}</ul>` : ''}
<h2>Requirement traceability</h2><ul class="trace">${crit || '<li class="no"><span class="box">○</span>no acceptance criteria captured</li>'}</ul>
<h2>Findings</h2>${sevBlock || '<p class="ctx">No findings at or above the confidence floor.</p>'}
${human ? `<h2>Open questions</h2>${human}` : ''}
${skip ? `<h2>Coverage notes</h2>${skip}` : ''}
${ctxItems.length ? `<h2>Context used</h2><div class="ctx">${ctxItems.map(c => `<div>› ${c}</div>`).join('')}</div>` : ''}
<div class="foot">adversarial-code-review · advisory, never edits code · ${verify.summary ? esc(verify.summary) : 'bounded adversarial verification'}</div>
</div></body></html>`;
}

const cap = s => s[0].toUpperCase() + s.slice(1);
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
