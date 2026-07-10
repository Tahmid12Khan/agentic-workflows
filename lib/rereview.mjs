// Pure: re-review convergence (WS3) — diffing one run's findings against the PRIOR run's,
// classifying a vanished finding as fixed vs a non-reproduction, the round counter that drives
// the nit-posting policy, and the policy itself. No I/O, no gh/git calls: report.mjs and
// comments.mjs own the state file / diff / gh-api side effects and pass in already-loaded data.
import { findingKey } from './memory.mjs';
import { inDiffScope } from './review-orchestration.mjs';

// Split this run's findings against the PREVIOUS run's into resolved/persisting/new, keyed on
// memory.mjs's findingKey — deliberately file+title only (line-insensitive), so a finding that
// merely drifted to a new line because of unrelated edits is still recognized as "the same
// finding" rather than counted as both a resolve and a new hit.
//   resolved:   was reported last time, not reported this time — a CANDIDATE fix (see
//               classifyVanished: it still needs the region-changed check before it's trusted).
//   persisting: reported both times — never re-posted; the report says "Still open".
//   new:        reported for the first time this run — posts normally, subject to the
//               convergence + nit-cap policy below.
export function diffFindings(prev = [], curr = []) {
  // Membership Sets only (never a key→finding Map) — two DISTINCT findings that happen to share a
  // key (same file+title, e.g. a generic title repeated at two different lines) must both survive
  // into their bucket rather than collapsing to whichever one a Map's last-write-wins.
  const prevKeys = new Set((prev ?? []).map(findingKey));
  const currKeys = new Set((curr ?? []).map(findingKey));
  const resolved = (prev ?? []).filter((f) => !currKeys.has(findingKey(f)));
  const persisting = (curr ?? []).filter((f) => prevKeys.has(findingKey(f)));
  const news = (curr ?? []).filter((f) => !prevKeys.has(findingKey(f)));
  return { resolved, persisting, new: news };
}

// A finding that vanished between reviews only counts as RESOLVED when the code at its OLD
// file:line actually changed in prevHead..head (`diffIndex`, built the same way as the off-diff
// demotion index — see trim-diff.mjs's buildDiffIndex — but over the prevHead..head range instead
// of the PR's base..head range). Reuses inDiffScope's slack-tolerant containment test: same
// semantics as "is this finding inside a changed hunk", just applied to a different range. If the
// flagged code was untouched, the finding simply didn't reproduce this pass (model variance, a
// different reviewer sampling, etc.) — never claim a fix that didn't happen.
export function classifyVanished(candidates = [], diffIndex = {}, slack = 3) {
  const resolved = [], notReproduced = [];
  for (const f of candidates ?? []) (inDiffScope(f, diffIndex, slack) ? resolved : notReproduced).push(f);
  return { resolved, notReproduced };
}

// Convergence round counter — persisted in last-review.json (report.mjs writes it, comments.mjs
// reads it). "Same PR continuing from a prior review" bumps the round; anything else (a
// different PR, or no prior state) restarts at 1. Falls back to base-equality when no PR number
// is available on either side (a local-branch review has no PR, but successive runs against the
// same base are still the same review lineage). No Date/random — round is derived purely from
// the previous state + this run's identity, so it's stable and replayable.
export function nextRound(prev, { base = null, prNumber = null } = {}) {
  if (!prev) return 1;
  const samePr = prNumber != null && prev.prNumber != null ? prev.prNumber === prNumber : prev.base === base;
  return samePr ? (Number(prev.round) || 1) + 1 : 1;
}

// Convergence policy (config rereview.nit_rounds, default 1): minor/suggestion findings post as
// comments through round `nitRounds`; from round nitRounds+1 on they are REPORT-ONLY — they still
// appear in review.md/review.html, they just never reach comments.mjs's posting loop. Anthropic's
// REVIEW.md guidance ("after round 1, important-only") is the origin of this default. critical/
// important are never affected — they always post (subject only to the confidence floor).
export function nitConvergence(findings = [], round = 1, nitRounds = 1) {
  if (round <= nitRounds) return { postable: findings ?? [], reportOnly: [] };
  const postable = [], reportOnly = [];
  for (const f of findings ?? []) {
    (f.severity === 'minor' || f.severity === 'suggestion') ? reportOnly.push(f) : postable.push(f);
  }
  return { postable, reportOnly };
}
