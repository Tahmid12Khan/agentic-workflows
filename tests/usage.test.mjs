import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICES, resolvePrices, priceFor, costOf, tallyLines, encodeProjectDir } from '../lib/usage.mjs';

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

test('encodeProjectDir mirrors Claude Code project-dir encoding', () => {
  assert.equal(encodeProjectDir('/Users/x/IdeaProjects/agentic-workflows'), '-Users-x-IdeaProjects-agentic-workflows');
  assert.equal(encodeProjectDir('/a/b.c/d'), '-a-b-c-d'); // dots also become dashes
});
