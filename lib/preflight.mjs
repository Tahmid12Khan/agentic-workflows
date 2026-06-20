#!/usr/bin/env node
// Preflight: verify the environment can run a review. Prints a report.
// Exit 1 if a REQUIRED tool is missing; 0 otherwise (optional tools only warn).
import { execFileSync } from 'node:child_process';

function has(cmd, args = ['--version']) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const report = { ok: [], warn: [], fail: [] };

// Node version (node:test + ESM require >= 18; >= 20 recommended)
const major = Number(process.versions.node.split('.')[0]);
if (major >= 20) report.ok.push(`node ${process.versions.node}`);
else if (major >= 18) report.warn.push(`node ${process.versions.node} (>=20 recommended)`);
else report.fail.push(`node ${process.versions.node} — need >= 18`);

// git + inside a work tree
if (!has('git')) {
  report.fail.push('git not found — required to compute the diff');
} else {
  report.ok.push('git');
  let inRepo = false;
  try {
    inRepo = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
      .toString().trim() === 'true';
  } catch { /* not a repo */ }
  if (inRepo) report.ok.push('inside a git work tree');
  else report.fail.push('not inside a git repository — run from your project root');
}

// gh — optional, only for --comment
if (has('gh')) {
  report.ok.push('gh (inline PR comments available)');
} else {
  report.warn.push('gh not found — `--comment` (inline PR comments) will be unavailable; report + gate still work');
}

const line = (s) => console.log('  ' + s);
console.log('Code-review preflight:');
report.ok.forEach((s) => line('✓ ' + s));
report.warn.forEach((s) => line('! ' + s));
report.fail.forEach((s) => line('✗ ' + s));

if (report.fail.length) {
  console.log(`\nBLOCKED: ${report.fail.length} required item(s) missing. Fix the ✗ items above.`);
  process.exit(1);
}
console.log('\nReady.');
process.exit(0);
