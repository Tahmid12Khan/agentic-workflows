import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PRICES, resolvePrices, priceFor, costOf, tallyLines, tallyByFamily, familyOf, cacheHitPct, encodeProjectDir, transcriptFiles, computeReviewUsage } from '../lib/usage.mjs';

test('priceFor matches model families by substring; unknown falls back to opus', () => {
  assert.equal(priceFor('claude-opus-4-8'), DEFAULT_PRICES.opus);
  assert.equal(priceFor('claude-sonnet-4-6'), DEFAULT_PRICES.sonnet);
  assert.equal(priceFor('claude-haiku-4-5-20251001'), DEFAULT_PRICES.haiku);
  assert.equal(priceFor('claude-fable-5'), DEFAULT_PRICES.fable);
  assert.equal(priceFor('claude-mythos-5'), DEFAULT_PRICES.fable);
  assert.equal(priceFor('something-new'), DEFAULT_PRICES.opus); // never undercount a miss
  assert.equal(priceFor(undefined), DEFAULT_PRICES.opus);
});

test('costOf prices each token bucket per MTok', () => {
  // 1M input on opus = $5, 1M output = $25, 1M cache-read = $0.50
  assert.equal(costOf({ input_tokens: 1_000_000 }, 'claude-opus-4-8'), 5);
  assert.equal(costOf({ output_tokens: 1_000_000 }, 'claude-opus-4-8'), 25);
  assert.equal(costOf({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-4-8'), 0.5);
});

test('costOf prices cache writes by the 5m/1h split when present, else treats all as 5m', () => {
  // explicit split: 1h is the pricier rate (2x input = $10/MTok on opus)
  const split = costOf({ cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 0 } }, 'claude-opus-4-8');
  assert.equal(split, 10);
  // no split → the whole creation count is the cheaper 5m rate (1.25x input = $6.25/MTok)
  const noSplit = costOf({ cache_creation_input_tokens: 1_000_000 }, 'claude-opus-4-8');
  assert.equal(noSplit, 6.25);
});

test('tallyLines sums usage and keeps only lines inside the time window', () => {
  const lines = [
    { timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 } } },
    { timestamp: '2026-06-30T09:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 999 } } }, // before window — dropped
    { timestamp: '2026-06-30T11:00:00Z', message: { role: 'user', content: 'hi' } },                              // no usage — ignored
    { message: { model: 'claude-opus-4-8', usage: { input_tokens: 7 } } },                                        // no timestamp — dropped under a window
  ];
  const acc = tallyLines(lines, { sinceMs: Date.parse('2026-06-30T09:30:00Z') });
  assert.equal(acc.inputTokens, 100);
  assert.equal(acc.outputTokens, 10);
  assert.equal(acc.cacheReadTokens, 5);
  assert.equal(acc.cacheWriteTokens, 2);
  assert.equal(acc.messages, 1);
  assert.ok(acc.costUsd > 0);
});

test('tallyLines with no window keeps every usage-bearing line', () => {
  const lines = [
    { message: { model: 'claude-haiku-4-5', usage: { input_tokens: 10 } } },
    { message: { model: 'claude-sonnet-4-6', usage: { output_tokens: 20 } } },
  ];
  const acc = tallyLines(lines);
  assert.equal(acc.messages, 2);
  assert.equal(acc.inputTokens, 10);
  assert.equal(acc.outputTokens, 20);
});

test('resolvePrices overlays config per family + field, leaving others default', () => {
  const p = resolvePrices({ usage: { pricing: { opus: { input: 99 } } } });
  assert.equal(p.opus.input, 99);
  assert.equal(p.opus.output, DEFAULT_PRICES.opus.output); // untouched field keeps default
  assert.deepEqual(p.sonnet, DEFAULT_PRICES.sonnet);        // untouched family keeps default
});

test('familyOf maps model ids to families; unknown → opus', () => {
  assert.equal(familyOf('claude-opus-4-8'), 'opus');
  assert.equal(familyOf('claude-sonnet-4-6'), 'sonnet');
  assert.equal(familyOf('claude-haiku-4-5-20251001'), 'haiku');
  assert.equal(familyOf('claude-fable-5'), 'fable');
  assert.equal(familyOf('claude-mythos-5'), 'fable');
  assert.equal(familyOf('something-new'), 'opus');
  assert.equal(familyOf(undefined), 'opus');
});

test('cacheHitPct = cacheRead / (cacheRead + input); null when nothing to divide', () => {
  assert.equal(cacheHitPct({ cacheReadTokens: 30, inputTokens: 10 }), 0.75);
  assert.equal(cacheHitPct({ cacheReadTokens: 0, inputTokens: 100 }), 0);
  assert.equal(cacheHitPct({ cacheReadTokens: 0, inputTokens: 0 }), null); // omit rather than show 0%
  assert.equal(cacheHitPct({}), null);
});

test('tallyByFamily splits usage per model family, honoring the window', () => {
  const lines = [
    { timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100 } } },
    { timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 20 } } },
    { timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 300 } } },
    { timestamp: '2026-06-30T08:00:00Z', message: { model: 'claude-haiku-4-5', usage: { input_tokens: 999 } } }, // before window
  ];
  const by = tallyByFamily(lines, { sinceMs: Date.parse('2026-06-30T09:00:00Z') });
  assert.equal(by.opus.inputTokens, 100);
  assert.equal(by.sonnet.inputTokens, 500);   // 200 + 300
  assert.equal(by.sonnet.messages, 2);
  assert.ok(!('haiku' in by), 'out-of-window line contributes no family bucket');
});

test('encodeProjectDir mirrors Claude Code project-dir encoding', () => {
  assert.equal(encodeProjectDir('/Users/x/IdeaProjects/agentic-workflows'), '-Users-x-IdeaProjects-agentic-workflows');
  assert.equal(encodeProjectDir('/a/b.c/d'), '-a-b-c-d'); // dots also become dashes
});

// --- transcriptFiles: recursive jsonl walk ---

test('transcriptFiles: main transcript is "orchestrator", direct + nested subagent transcripts are "subagents"', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-tf-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    const wfDir = join(projDir, 'sess1', 'subagents', 'workflows', 'wf_x');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(projDir, 'sess1.jsonl'), '');
    writeFileSync(join(projDir, 'sess1', 'subagents', 'agent-a.jsonl'), '');
    writeFileSync(join(wfDir, 'agent-b.jsonl'), '');

    const files = transcriptFiles({ home, cwd: '/proj', sessionId: 'sess1' });
    const byScope = files.reduce((m, f) => ((m[f.scope] = (m[f.scope] || 0) + 1), m), {});
    assert.equal(byScope.orchestrator, 1);
    assert.equal(byScope.subagents, 2, 'both the direct and the doubly-nested workflow transcript must be found');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('transcriptFiles: no sessionId falls back to scanning the whole project dir', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-tf-fallback-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    mkdirSync(join(projDir, 'other-session', 'subagents'), { recursive: true });
    writeFileSync(join(projDir, 'other-session.jsonl'), '');
    writeFileSync(join(projDir, 'other-session', 'subagents', 'agent-c.jsonl'), '');

    const files = transcriptFiles({ home, cwd: '/proj', sessionId: null });
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.scope === 'orchestrator'));
    assert.ok(files.some((f) => f.scope === 'subagents'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('transcriptFiles: no project dir at all → empty list, never throws', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-tf-empty-'));
  try {
    assert.deepEqual(transcriptFiles({ home, cwd: '/never-reviewed', sessionId: 'x' }), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// --- computeReviewUsage: malformed lines, the since-window, deterministic breakdown sort ---

test('computeReviewUsage: a malformed jsonl line is skipped, not fatal to the rest of the run', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-cru-malformed-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    mkdirSync(projDir, { recursive: true });
    const line = (o) => JSON.stringify(o) + '\n';
    writeFileSync(join(projDir, 'sess1.jsonl'),
      line({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } } }) +
      '{not valid json\n' +
      line({ timestamp: '2026-06-30T10:01:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 50, output_tokens: 5 } } }));

    const usage = computeReviewUsage({ home, cwd: '/proj', sessionId: 'sess1', since: '2026-06-30T09:00:00Z' });
    assert.equal(usage.inputTokens, 150);   // both valid lines counted, the malformed one skipped
    assert.equal(usage.messages, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('computeReviewUsage: the since-window excludes entries timestamped before it', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-cru-window-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    mkdirSync(projDir, { recursive: true });
    const line = (o) => JSON.stringify(o) + '\n';
    writeFileSync(join(projDir, 'sess1.jsonl'),
      line({ timestamp: '2026-06-30T08:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 9999 } } }) +
      line({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } } }));

    const usage = computeReviewUsage({ home, cwd: '/proj', sessionId: 'sess1', since: '2026-06-30T09:00:00Z' });
    assert.equal(usage.inputTokens, 100, 'the pre-window entry must be excluded');
    assert.equal(usage.messages, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('computeReviewUsage: breakdown is sorted by cost desc, deterministically (stable across repeat calls)', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-cru-sort-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    const subDir = join(projDir, 'sess1', 'subagents');
    mkdirSync(subDir, { recursive: true });
    const line = (o) => JSON.stringify(o) + '\n';
    writeFileSync(join(projDir, 'sess1.jsonl'),
      line({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 100 } } }));
    writeFileSync(join(subDir, 'agent-a.jsonl'),
      line({ timestamp: '2026-06-30T10:01:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 20 } } }));

    const since = '2026-06-30T09:00:00Z';
    const a = computeReviewUsage({ home, cwd: '/proj', sessionId: 'sess1', since });
    const b = computeReviewUsage({ home, cwd: '/proj', sessionId: 'sess1', since });
    assert.deepEqual(a.breakdown.map((r) => `${r.scope}/${r.model}`), b.breakdown.map((r) => `${r.scope}/${r.model}`));
    assert.equal(a.breakdown[0].scope, 'orchestrator'); // opus/orchestrator costs more — sorted first
    assert.ok(a.breakdown[0].costUsd >= a.breakdown[1].costUsd);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('computeReviewUsage: returns null when config disables usage tracking', () => {
  const home = mkdtempSync(join(tmpdir(), 'acr-cru-disabled-'));
  try {
    const projDir = join(home, '.claude', 'projects', '-proj');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'sess1.jsonl'), JSON.stringify({ timestamp: '2026-06-30T10:00:00Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100 } } }) + '\n');
    const usage = computeReviewUsage({ home, cwd: '/proj', sessionId: 'sess1', since: '2026-06-30T09:00:00Z', config: { usage: { enabled: false } } });
    assert.equal(usage, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
