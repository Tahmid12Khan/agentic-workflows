#!/usr/bin/env node
// CLI + library: tally the token usage + USD cost of ONE review run from the
// Claude Code session transcripts, so the report can show what the review cost.
//
// A review fans out across many subagents; the orchestrator turns land in the
// session's main transcript and every reviewer/verifier turn lands in a sibling
// `<session>/subagents/agent-*.jsonl`. Both carry per-message `usage` blocks
// (input / output / cache-read / cache-write tokens) and the `model` that ran.
// We scope to THIS session and a time window (the review's start) and sum them —
// "this review run only", as opposed to the whole session or all of history.
//
// Cost is derived from a per-model-family price table (USD per million tokens),
// overridable via `.adverserial-code-review/config.json` → `usage.pricing`.
// Best-effort: a missing transcript dir or unparseable line degrades to an empty
// tally (returns null), never throws — the report renders fine without it.
//
// Usage: node usage.mjs [--since <ISO>] [--session <id>] [--cwd <dir>] [--home <dir>]
// Prints { usage: {...} | null } to stdout.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Per-model-family pricing, USD per MILLION tokens. cacheWrite5m = 1.25× input,
// cacheWrite1h = 2× input, cacheRead = 0.1× input (Anthropic prompt-caching
// economics). Claude Code writes 1h cache entries, so the 5m/1h split matters —
// see costOf. All Opus 4.x share one price; family match is by substring so a
// point release (4.6/4.7/4.8) needs no table change.
export const DEFAULT_PRICES = {
  opus: { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  fable: { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1.0 },
};

// Merge config overrides over the defaults, per family + per field (so a config
// can correct just opus.input without restating the whole table).
export function resolvePrices(config = {}) {
  const over = config?.usage?.pricing ?? {};
  const out = {};
  for (const fam of Object.keys(DEFAULT_PRICES)) out[fam] = { ...DEFAULT_PRICES[fam], ...(over[fam] ?? {}) };
  return out;
}

// A model id → its family rate. Unknown ids fall back to opus: the orchestrator
// runs on opus and an unrecognized string is most likely an opus variant, so we
// over- rather than under-state the cost of a miss.
export function priceFor(model, prices = DEFAULT_PRICES) {
  const id = String(model ?? '').toLowerCase();
  if (id.includes('haiku')) return prices.haiku;
  if (id.includes('sonnet')) return prices.sonnet;
  if (id.includes('fable') || id.includes('mythos')) return prices.fable;
  return prices.opus;          // opus + any unknown
}

// USD cost of ONE usage block. Cache writes are priced by their 5m/1h split when
// the transcript carries it (usage.cache_creation), else the whole creation count
// is treated as 5m — the cheaper rate, so an absent split never overstates cost.
export function costOf(usage = {}, model, prices = DEFAULT_PRICES) {
  const p = priceFor(model, prices);
  const split = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : null;
  const w5 = split ? (split.ephemeral_5m_input_tokens ?? 0) : (usage.cache_creation_input_tokens ?? 0);
  const w1 = split ? (split.ephemeral_1h_input_tokens ?? 0) : 0;
  const dollars =
    (usage.input_tokens ?? 0) * p.input +
    (usage.output_tokens ?? 0) * p.output +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
    w5 * p.cacheWrite5m +
    w1 * p.cacheWrite1h;
  return dollars / 1_000_000;
}

const emptyTally = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, messages: 0 });

// Pure: sum the usage across parsed transcript line objects, keeping only lines
// whose timestamp is >= sinceMs (a line with no/invalid timestamp is dropped when
// a window is set — it can't be attributed to this run). Lines without a
// message.usage block (user turns, tool results, meta) are ignored.
export function tallyLines(lines, { sinceMs = null, prices = DEFAULT_PRICES } = {}) {
  const acc = emptyTally();
  for (const o of lines) {
    if (sinceMs != null) {
      const ts = Date.parse(o?.timestamp);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }
    const u = o?.message?.usage;
    if (!u) continue;
    acc.inputTokens += u.input_tokens ?? 0;
    acc.outputTokens += u.output_tokens ?? 0;
    acc.cacheReadTokens += u.cache_read_input_tokens ?? 0;
    acc.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
    acc.costUsd += costOf(u, o?.message?.model, prices);
    acc.messages += 1;
  }
  return acc;
}

function addTally(a, b) {
  a.inputTokens += b.inputTokens; a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens; a.cacheWriteTokens += b.cacheWriteTokens;
  a.costUsd += b.costUsd; a.messages += b.messages;
  return a;
}

// Claude Code stores a session's transcript at projects/<encoded-cwd>/. The cwd
// is encoded by replacing every '/' and '.' with '-'.
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[/.]/g, '-');
}

// The transcript files for ONE review: the session's main transcript plus every
// subagent transcript it spawned. When the session id is unknown we fall back to
// every transcript in the project dir (the time window still scopes it to the
// run) — broader, but never empty for lack of an id.
export function transcriptFiles({ home, cwd, sessionId }) {
  const dir = join(home, '.claude', 'projects', encodeProjectDir(cwd));
  if (!existsSync(dir)) return [];
  const files = [];
  const subagentsIn = (d) => {
    const sub = join(d, 'subagents');
    if (!existsSync(sub)) return;
    for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(join(sub, f));
  };
  if (sessionId) {
    const main = join(dir, `${sessionId}.jsonl`);
    if (existsSync(main)) files.push(main);
    subagentsIn(join(dir, sessionId));
  }
  if (files.length === 0) {                            // fallback: the whole project dir
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) files.push(join(dir, e.name));
      else if (e.isDirectory()) subagentsIn(join(dir, e.name));
    }
  }
  return files;
}

function readConfig() {
  try { return JSON.parse(readFileSync('.adverserial-code-review/config.json', 'utf8')); } catch { return {}; }
}

// Top-level: the usage of this review run, or null when there is nothing to show
// (disabled by config, no transcript dir, or no usage in the window) so the
// renderer can simply omit the panel. Defaults source the session + cwd + home
// from the process so report.mjs can call it with just `{ since }`.
export function computeReviewUsage({
  home = homedir(),
  cwd = process.cwd(),
  sessionId = process.env.CLAUDE_CODE_SESSION_ID || null,
  since = null,
  config = null,
} = {}) {
  const cfg = config ?? readConfig();
  if (cfg?.usage?.enabled === false) return null;
  const prices = resolvePrices(cfg);
  const sinceMs = since ? Date.parse(since) : null;
  const files = transcriptFiles({ home, cwd, sessionId });
  const acc = emptyTally();
  for (const f of files) {
    let text;
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = [];
    for (const ln of text.split('\n')) {
      if (!ln.trim()) continue;
      try { lines.push(JSON.parse(ln)); } catch { /* skip a malformed line, never the whole run */ }
    }
    addTally(acc, tallyLines(lines, { sinceMs: Number.isNaN(sinceMs) ? null : sinceMs, prices }));
  }
  if (acc.messages === 0) return null;
  return { ...acc, scope: sessionId ? 'session' : 'project' };
}

// --- thin CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const usage = computeReviewUsage({
    since: arg('--since'),
    sessionId: arg('--session', process.env.CLAUDE_CODE_SESSION_ID || null),
    cwd: arg('--cwd', process.cwd()),
    home: arg('--home', homedir()),
  });
  process.stdout.write(JSON.stringify({ usage }, null, 2) + '\n');
}
