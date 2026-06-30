// Pure: extract from a unified `git diff` only the per-file sections whose path is in `files`.
//
// Used to hand a shard-scoped dimension reviewer just the hunks for ITS files instead of
// broadcasting the whole diff (the single dominant input-token cost across the pipeline).
// Whole file sections are kept verbatim — every context line is preserved, never a partial-line
// cut — so a reviewer reads complete hunks, and Read/Grep still let it pull sibling context.
//
// SAFETY (the cost-of-miss tradeoff): a reviewer that never SEES a change can never raise a
// finding, and that false-negative is invisible to the verifier. So any parse anomaly — input
// that is not a recognizable git diff, OR a filter that would drop EVERY section (a path-format
// mismatch) — falls back to returning the FULL diff. We never silently hand a reviewer a short
// or empty diff. Callers additionally exclude D3 (security) so cross-file taint stays whole.

export function filterDiff(diff, files) {
  if (typeof diff !== 'string' || diff === '') return diff;
  const wanted = new Set((files ?? []).map(normPath).filter(Boolean));
  if (wanted.size === 0) return diff;                 // nothing to scope to → full diff
  const sections = splitSections(diff);
  if (sections.length === 0) return diff;             // not a parseable git diff → full diff
  const kept = sections.filter((s) => s.path && wanted.has(s.path));
  if (kept.length === 0) return diff;                 // path-format mismatch → never drop everything
  return kept.map((s) => s.text).join('');
}

// Mechanically-generated / vendored paths the plan ALREADY drops from `files` and `netLoc`
// (plan.mjs imports this very constant). The raw `git diff`, however, still contains their
// (often huge) hunks — a lockfile alone can be thousands of lines. Single source of truth so the
// file list and the diff agree on what "noise" is.
export const NOISE_RE = /(^|\/)(dist|build|out|coverage|node_modules)\/|\.(lock|min\.js|map|snap|pb\.go)$|(^|\/)package-lock\.json$/i;

// Drop the noise sections from a diff before handing it to the Intent-phase agents
// (intent-harvester, business-logic-analyzer) — none of them review a lockfile or
// build artifact, and a dependency bump is already signalled elsewhere (depsChanged → D15). This
// is the SAFE trim: it removes only mechanically-generated files, never a source/test/config hunk,
// so it cannot starve a reviewer of real changed code. Same cost-of-miss invariant as filterDiff —
// if stripping would drop EVERY section (or the input is not a parseable diff), return the full
// diff rather than nothing; if nothing is noise, return the original unchanged (stable).
export function stripNoise(diff, noise = NOISE_RE) {
  if (typeof diff !== 'string' || diff === '') return diff;
  const sections = splitSections(diff);
  if (sections.length === 0) return diff;                  // not a parseable git diff → full diff
  const kept = sections.filter((s) => !s.path || !noise.test(s.path)); // keep unclassifiable too
  if (kept.length === 0) return diff;                      // would drop everything → full diff
  if (kept.length === sections.length) return diff;        // nothing was noise → original
  return kept.map((s) => s.text).join('');
}

// Strip the a/ or b/ diff prefix and any trailing "\t<timestamp>" so a header path compares
// equal to a plain repo-relative path (the form git diff --name-only / shards use).
export function normPath(p) {
  if (typeof p !== 'string') return '';
  return p.split('\t')[0].replace(/^[ab]\//, '').trim();
}

// Split on each "diff --git " line start, KEEPING the delimiter (lookahead), so each section is
// the file's full original text — newlines and "\ No newline at end of file" markers intact.
function splitSections(diff) {
  return diff
    .split(/^(?=diff --git )/m)
    .filter((p) => p.startsWith('diff --git '))
    .map((text) => ({ text, path: sectionPath(text) }));
}

// The file a section touches: prefer the new-file (+++) path, fall back to the old (---) path
// for deletions, then the "diff --git a/x b/y" header for pure mode/rename sections with no hunks.
function sectionPath(text) {
  const plus = /^\+\+\+ (.+)$/m.exec(text);
  if (plus && plus[1].trim() !== '/dev/null') return normPath(plus[1]);
  const minus = /^--- (.+)$/m.exec(text);
  if (minus && minus[1].trim() !== '/dev/null') return normPath(minus[1]);
  const git = /^diff --git a\/(.+) b\/(.+)$/m.exec(text);
  if (git) return normPath(git[2]);
  return '';
}
