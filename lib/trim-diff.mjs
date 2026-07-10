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

// Drop the noise sections from a diff before handing it to the Intent-phase agent
// (intent-analyzer) — it does not review a lockfile or
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

// Pure: map each changed file → the list of [start,end] line ranges it touches on the NEW
// side of the diff (the line numbers findings anchor on), parsed from the @@ hunk headers.
// A file that appears in the diff but has NO new-side hunks (pure deletion, mode change,
// rename-only) maps to an EMPTY array — it is still "in the changed set" (its path is a key),
// so findings on it are kept (they can't be localized on the new side). Used by inDiffScope
// (lib/review-orchestration.mjs) to demote findings anchored outside the actual change.
// Never throws; a non-string / empty diff yields an empty index.
export function buildDiffIndex(diff) {
  const index = {};
  if (typeof diff !== 'string' || diff === '') return index;
  for (const s of splitSections(diff)) {
    if (!s.path) continue;
    const ranges = index[s.path] ?? (index[s.path] = []);
    const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let m;
    while ((m = re.exec(s.text)) !== null) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);   // "@@ +12 @@" (no count) means 1 line
      if (!Number.isFinite(start) || count <= 0) continue;   // deletion-only hunk (+n,0) adds no new-side line
      ranges.push([start, start + count - 1]);
    }
  }
  return index;
}

// Pure: split a unified git diff into per-file sections → { [normPath]: sectionText }.
// Reuses splitSections, so each value is that file's complete, verbatim diff (whole hunks +
// context + "\ No newline" markers). Used by build-args.mjs to write per-file slices to disk so a
// dimension reviewer Reads ONLY its files' hunks (args.sliceIndex path) instead of the whole diff —
// the dominant input-token cost. Same safety story as filterDiff: this is an OPTIMIZATION, so any
// consumer that can't find a file's slice falls back to the full diff at diffPath. A section with
// no recognizable path is skipped; an empty / non-diff input yields {}. Never throws.
export function splitByFile(diff) {
  const out = {};
  if (typeof diff !== 'string' || diff === '') return out;
  for (const s of splitSections(diff)) {
    if (!s.path) continue;
    out[s.path] = (out[s.path] ?? '') + s.text;   // ≥2 sections for one path (rare) → concatenate
  }
  return out;
}

// Decode a git-quoted path. core.quotepath (default true) wraps a header path containing
// non-ASCII or other special bytes in double quotes with C-style + octal escapes, e.g.
// `"b/caf\303\251.js"`. capture-diff.mjs disables this at the source (-c core.quotePath=false),
// but this stays defensive for diffs captured elsewhere. Returns the input unchanged if it isn't
// quoted. Octal escapes are raw BYTES — a multi-byte UTF-8 character is split across several
// \nnn escapes — so bytes are collected first and decoded as UTF-8 once; decoding octal-by-octal
// would mis-split a multi-byte character.
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

// Strip the a/ or b/ diff prefix and any trailing "\t<timestamp>" so a header path compares
// equal to a plain repo-relative path (the form git diff --name-only / shards use). Unquotes a
// git-quoted path first (see unquoteGitPath) — the a/ b/ prefix lives INSIDE the quotes.
export function normPath(p) {
  if (typeof p !== 'string') return '';
  const s = unquoteGitPath(p.split('\t')[0].trim());
  return s.replace(/^[ab]\//, '').trim();
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
// for deletions, then the "diff --git a/x b/y" header for pure mode/rename/binary sections with
// no +++/--- lines at all. Quoted (both sides double-quoted, e.g. non-ASCII under quotepath=true)
// is tried before the bare a/...  b/... form so a quoted rename/binary path isn't dropped.
function sectionPath(text) {
  const plus = /^\+\+\+ (.+)$/m.exec(text);
  if (plus && plus[1].trim() !== '/dev/null') return normPath(plus[1]);
  const minus = /^--- (.+)$/m.exec(text);
  if (minus && minus[1].trim() !== '/dev/null') return normPath(minus[1]);
  const gitLine = /^diff --git (.+)$/m.exec(text);
  if (gitLine) {
    const rest = gitLine[1];
    const quoted = /^"a\/(?:[^"\\]|\\.)*"\s+"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
    if (quoted) return normPath(`"b/${quoted[1]}"`);
    const bare = /^a\/(.+) b\/(.+)$/.exec(rest);
    if (bare) return normPath(bare[2]);
  }
  return '';
}
