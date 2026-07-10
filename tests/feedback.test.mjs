import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  countReactions, subtractSeed, extractReplies, aggregateFeedback,
  loadPostedComments, savePostedComments, recordPostedComments, DEFAULT_STORE,
} from '../lib/feedback.mjs';
import { applyFeedback, applyLearnings, EMPTY, findingKey } from '../lib/memory.mjs';

// --- reaction/reply parsing ---
test('countReactions counts only +1/-1 content, ignores other reaction types', () => {
  const raw = [{ content: '+1' }, { content: '+1' }, { content: '-1' }, { content: 'heart' }, { content: 'eyes' }];
  assert.deepEqual(countReactions(raw), { plus1: 2, minus1: 1 });
});
test('countReactions degrades to zeros on empty/missing input', () => {
  assert.deepEqual(countReactions([]), { plus1: 0, minus1: 0 });
  assert.deepEqual(countReactions(undefined), { plus1: 0, minus1: 0 });
});

test('subtractSeed removes the one self-seeded reaction of each kind', () => {
  // comments.mjs seeds exactly one +1 and one -1 on every posted comment
  assert.deepEqual(subtractSeed({ plus1: 1, minus1: 1 }), { up: 0, down: 0 });      // no human vote yet
  assert.deepEqual(subtractSeed({ plus1: 2, minus1: 1 }), { up: 1, down: 0 });      // one 👍
  assert.deepEqual(subtractSeed({ plus1: 1, minus1: 3 }), { up: 0, down: 2 });      // two 👎
});
test('subtractSeed floors at 0 — a failed seed post never reads as a phantom vote', () => {
  assert.deepEqual(subtractSeed({ plus1: 0, minus1: 0 }), { up: 0, down: 0 });
});

test('extractReplies filters by in_reply_to_id and truncates to 300 chars', () => {
  const all = [
    { in_reply_to_id: 1, body: 'x'.repeat(400) },
    { in_reply_to_id: 2, body: 'not for us' },
    { in_reply_to_id: 1, body: 'short reply' },
  ];
  const replies = extractReplies(all, 1);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].length, 300);
  assert.equal(replies[1], 'short reply');
});
test('extractReplies returns [] when there are no replies', () => {
  assert.deepEqual(extractReplies([{ in_reply_to_id: 9, body: 'other' }], 1), []);
});

// --- aggregation ---
test('aggregateFeedback: tie (up === down) is a no-op, including 0 === 0', () => {
  const comments = [{ id: 1, key: 'a.ts::x' }];
  const reactionsById = new Map([[1, [{ content: '+1' }, { content: '-1' }]]]); // seed only, no votes
  assert.deepEqual(aggregateFeedback(comments, reactionsById, []), []);

  const tiedVotes = new Map([[1, [{ content: '+1' }, { content: '+1' }, { content: '-1' }, { content: '-1' }]]]); // 1 up, 1 down after seed subtraction
  assert.deepEqual(aggregateFeedback(comments, tiedVotes, []), []);
});
test('aggregateFeedback emits {key,up,down,replies} for a real down-vote', () => {
  const comments = [{ id: 1, key: 'a.ts::x' }];
  const reactionsById = new Map([[1, [{ content: '+1' }, { content: '-1' }, { content: '-1' }]]]); // seed + 1 human 👎
  const all = [{ in_reply_to_id: 1, body: 'this is fine actually' }];
  const [f] = aggregateFeedback(comments, reactionsById, all);
  assert.deepEqual(f, { key: 'a.ts::x', up: 0, down: 1, replies: ['this is fine actually'] });
});
test('aggregateFeedback combines multiple comments that share a finding key (re-review drift)', () => {
  const comments = [{ id: 1, key: 'a.ts::x' }, { id: 2, key: 'a.ts::x' }];
  const reactionsById = new Map([
    [1, [{ content: '+1' }, { content: '-1' }, { content: '-1' }]], // seed + 1 human down
    [2, [{ content: '+1' }, { content: '-1' }]],                    // seed only, no human vote
  ]);
  const [f] = aggregateFeedback(comments, reactionsById, []);
  assert.deepEqual(f, { key: 'a.ts::x', up: 0, down: 1, replies: [] }); // summed across both comment ids
});
test('aggregateFeedback: a net tie across multiple comments sharing a key is still a no-op', () => {
  const comments = [{ id: 1, key: 'a.ts::x' }, { id: 2, key: 'a.ts::x' }];
  const reactionsById = new Map([
    [1, [{ content: '+1' }, { content: '-1' }, { content: '-1' }]], // +1 down
    [2, [{ content: '+1' }, { content: '+1' }, { content: '-1' }]], // +1 up
  ]);
  assert.deepEqual(aggregateFeedback(comments, reactionsById, []), []); // net up===down (1 vs 1) -> tie
});

// --- posted-comments state (load/save/record) ---
let dir;
test.beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acr-feedback-')); });
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('loadPostedComments degrades to empty state on missing or corrupt file', () => {
  assert.deepEqual(loadPostedComments(join(dir, 'nope.json')), { version: 1, prs: {} });
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(loadPostedComments(bad), { version: 1, prs: {} });
});

test('recordPostedComments dedupes by comment id and preserves other PRs', () => {
  let state = recordPostedComments({ version: 1, prs: {} }, { pr: 1, base: 'B', head: 'H1', comments: [{ id: 10, key: 'a.ts::x' }] });
  state = recordPostedComments(state, { pr: 2, base: 'B', head: 'H2', comments: [{ id: 20, key: 'b.ts::y' }] });
  // re-recording pr 1 with an overlapping id (re-post at same id, shouldn't duplicate) plus a new one
  state = recordPostedComments(state, { pr: 1, base: 'B', head: 'H1b', comments: [{ id: 10, key: 'a.ts::x' }, { id: 11, key: 'a.ts::z' }] });

  assert.equal(state.prs['1'].comments.length, 2);
  assert.equal(state.prs['1'].head, 'H1b'); // latest head wins
  assert.equal(state.prs['2'].comments.length, 1); // untouched by pr-1 updates
});

test('savePostedComments + loadPostedComments round-trip', () => {
  const path = join(dir, 'posted-comments.json');
  const state = recordPostedComments({ version: 1, prs: {} }, { pr: 5, base: 'B', head: 'H', comments: [{ id: 1, key: 'a.ts::x', file: 'a.ts', line: 3, title: 'x' }] });
  savePostedComments(path, state);
  assert.deepEqual(loadPostedComments(path), state);
});

test('DEFAULT_STORE points at the plugin dot-dir', () => {
  assert.equal(DEFAULT_STORE, '.adversarial-code-review/posted-comments.json');
});

// --- acceptance: a fixture PR round-trip turns a 👎 into a suppressed finding on the next run ---
test('a 👎-only comment becomes an accepted-false-positive that applyLearnings suppresses next run', () => {
  const finding = { file: 'a.ts', title: 'off-by-one' };
  const key = findingKey(finding);
  const comments = [{ id: 42, key, file: 'a.ts', line: 5, title: 'off-by-one' }];
  const reactionsById = new Map([[42, [{ content: '+1' }, { content: '-1' }, { content: '-1' }]]]); // seed + one human 👎
  const allComments = [{ in_reply_to_id: 42, body: 'not a bug, intentional' }];

  const results = aggregateFeedback(comments, reactionsById, allComments);
  const learnings = applyFeedback(EMPTY, results, { pr: 7 });

  assert.equal(learnings.acceptedFalsePositives.length, 1);
  assert.equal(learnings.acceptedFalsePositives[0].key, key);
  assert.match(learnings.acceptedFalsePositives[0].note, /PR #7/);
  assert.equal(learnings.acceptedFalsePositives[0].context, 'not a bug, intentional');

  const { kept, suppressed } = applyLearnings([finding], learnings);
  assert.equal(suppressed.length, 1);
  assert.equal(kept.length, 0);
});

test('a 👍-only comment does not affect acceptedFalsePositives (no down-vote, nothing to suppress)', () => {
  const finding = { file: 'b.ts', title: 'real bug' };
  const comments = [{ id: 43, key: findingKey(finding) }];
  const reactionsById = new Map([[43, [{ content: '+1' }, { content: '+1' }, { content: '-1' }]]]); // seed + one human 👍
  const results = aggregateFeedback(comments, reactionsById, []);
  const learnings = applyFeedback(EMPTY, results, { pr: 9 });

  assert.equal(learnings.acceptedFalsePositives.length, 0);

  const { kept } = applyLearnings([finding], learnings);
  assert.equal(kept.length, 1);
});
