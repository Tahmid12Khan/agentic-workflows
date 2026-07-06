#!/usr/bin/env node
// CLI: emit the raw unified diff for the review range, deterministically.
// Usage: node capture-diff.mjs --base <ref> [--head <ref>]
//   Prints `git diff --no-color <base>..<head>` (head defaults to HEAD) verbatim to stdout —
//   the caller redirects it to $SCRATCH/diff.txt.
// WHY a script instead of the runbook's old `git diff <base>..HEAD > diff.txt`: that line invited
// the orchestrating model to "helpfully" reformat the capture (stat header + indented hunks), which
// silently broke every DOWNSTREAM parser that keys on raw git markers — buildDiffIndex (needs
// `^@@`/`^diff --git`, so a mangled diff yields an EMPTY index → every finding demoted out-of-diff)
// and context-pack.mjs (finds no new-side content → empty pack → reviewers wander the repo). A node
// step is opaque: its stdout is redirected verbatim, so the diff can never be reshaped in transit.
// Degrade-only: on git failure prints nothing (exit 0) so the run continues on the fallback path,
// same contract as the other best-effort inputs.
import { execFileSync } from 'node:child_process';

// Pure: the git argv for the range. `--no-color` so no ANSI leaks into the parsers; three-dot vs
// two-dot is deliberately two-dot (base..head) to match plan.mjs's range and the runbook.
export function diffArgs(base, head = 'HEAD') {
  return ['diff', '--no-color', `${base}..${head}`];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const base = arg('base', null);
  if (!base) {
    process.stderr.write('capture-diff: --base <ref> is required\n');
    process.exit(2);
  }
  try {
    // maxBuffer bumped well past the default 1 MB: a large PR diff must not truncate (a partial
    // diff would re-break the parsers this script exists to feed).
    const out = execFileSync('git', diffArgs(base, arg('head', 'HEAD')), { maxBuffer: 256 * 1024 * 1024 });
    process.stdout.write(out);
  } catch (e) {
    // Degrade, don't crash: emit nothing and let the pipeline fall open (context-pack/history/
    // build-args all tolerate an empty diff). Surface the reason on stderr for the operator.
    process.stderr.write(`capture-diff: git diff failed: ${e.message}\n`);
  }
}
