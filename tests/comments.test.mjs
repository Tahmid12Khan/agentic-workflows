import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewPayload, buildReviewArgs, commentLocation, buildCommentBody, buildReplyArgs, resolvedReplyBody, NOT_REPRODUCED_BODY, resolveThreadMutation, buildSummaryComment } from '../lib/comments.mjs';

const COMMENTS = new URL('../lib/comments.mjs', import.meta.url).pathname;

// --- WS9: --comment batching (one review instead of N individual comment POSTs) ---

test('buildReviewArgs: POSTs to the reviews endpoint with the body piped via stdin', () => {
  assert.deepEqual(buildReviewArgs(42), ['api', 'repos/{owner}/{repo}/pulls/42/reviews', '-X', 'POST', '--input', '-']);
});

test('buildReviewPayload: maps each finding to a review comment, single- and multi-line', () => {
  const single = { file: 'a.ts', line: 5, severity: 'important', dimension: 'D2', title: 'off-by-one', confidence: 88 };
  const multi = { file: 'b.ts', line: 10, endLine: 12, severity: 'minor', title: 'dup block', confidence: 82 };
  const payload = buildReviewPayload([single, multi], { head: 'deadbeef' });
  assert.equal(payload.commit_id, 'deadbeef');
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.comments.length, 2);
  assert.deepEqual(payload.comments[0], { path: 'a.ts', body: buildCommentBody(single), line: 5, side: 'RIGHT' });
  assert.deepEqual(payload.comments[1], { path: 'b.ts', body: buildCommentBody(multi), line: 12, side: 'RIGHT', start_line: 10, start_side: 'RIGHT' });
  // sanity: matches commentLocation's own anchor for the multi-line case
  assert.equal(payload.comments[1].line, commentLocation(multi).line);
});

test('buildReviewPayload: empty input yields an empty comments array (nothing to post)', () => {
  assert.deepEqual(buildReviewPayload([], { head: 'abc' }).comments, []);
});

// --- thread replies + resolution ---

test('buildReplyArgs posts a thread reply via in_reply_to on the review-comments endpoint', () => {
  assert.deepEqual(buildReplyArgs(12345, 'hello', { pr: 7 }),
    ['api', 'repos/{owner}/{repo}/pulls/7/comments', '-f', 'body=hello', '-F', 'in_reply_to=12345']);
});

test('resolvedReplyBody names the short (8-char) resolving sha', () => {
  assert.equal(resolvedReplyBody('abcdef1234567890'), '✅ Resolved in `abcdef12`.');
  assert.equal(resolvedReplyBody(''), '✅ Resolved in ``.');       // edge: empty sha never throws
  assert.equal(resolvedReplyBody(undefined), '✅ Resolved in ``.'); // edge: missing sha never throws
});

test('NOT_REPRODUCED_BODY is a fixed, non-resolving message (distinct from "resolved")', () => {
  assert.match(NOT_REPRODUCED_BODY, /did not reproduce/);
  assert.match(NOT_REPRODUCED_BODY, /no longer reproduced/);
  assert.doesNotMatch(NOT_REPRODUCED_BODY, /✅/);
});

test('resolveThreadMutation builds the GraphQL resolveReviewThread mutation for a thread id', () => {
  const q = resolveThreadMutation('PRT_kwabc123');
  assert.match(q, /mutation/);
  assert.match(q, /resolveReviewThread/);
  assert.match(q, /threadId: "PRT_kwabc123"/);
});

// --- summary comment ---

test('buildSummaryComment: counts findings by severity, flags needs-human, names verdict/tier', () => {
  const body = buildSummaryComment({ verdict: 'BLOCK', tier: 'critical', findings: [{ severity: 'critical' }, { severity: 'minor' }], needsHuman: [{ question: 'q' }] });
  assert.match(body, /BLOCK/);
  assert.match(body, /critical/);
  assert.match(body, /1 critical, 1 minor/);
  assert.match(body, /1 item\(s\) need your input/);
});

test('buildSummaryComment: empty findings → "no blocking findings"; empty needsHuman → no input line', () => {
  const body = buildSummaryComment({ verdict: 'APPROVE', tier: 'standard', findings: [], needsHuman: [] });
  assert.match(body, /no blocking findings/);
  assert.doesNotMatch(body, /need your input/);
});

test('buildSummaryComment footer states the advisory-only invariant + the /review-respond --fix opt-in', () => {
  const body = buildSummaryComment({ verdict: 'APPROVE', tier: 'standard', findings: [] });
  assert.match(body, /advisory/);
  assert.match(body, /\/review-respond --fix/);
});

// --- MIN_CONFIDENCE eligibility boundary (comments.mjs --dry-run) ---

test('comments.mjs --dry-run: confidence 80 is eligible to post, 79 is not (MIN_CONFIDENCE boundary)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'acr-conf-'));
  try {
    const finding = (confidence) => JSON.stringify({ findings: [{ file: 'a.ts', line: 5, severity: 'minor', dimension: 'D2', title: 'x', confidence }] });
    const at80 = JSON.parse(execFileSync(process.execPath, [COMMENTS, '--dry-run'], { input: finding(80), cwd: tmp, encoding: 'utf8' }));
    assert.equal(at80.length, 1);
    const at79 = JSON.parse(execFileSync(process.execPath, [COMMENTS, '--dry-run'], { input: finding(79), cwd: tmp, encoding: 'utf8' }));
    assert.equal(at79.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
