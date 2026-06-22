#!/usr/bin/env node
// Hook (PostToolUse, Edit|Write|MultiEdit): node --check the edited .mjs file so a
// syntax error is caught the instant it is written, not when a review run crashes.
// Reads the hook JSON on stdin; exits 2 with a message on stderr if the file does
// not parse (Claude Code feeds stderr back to the model), exits 0 otherwise.
// Degrades to a no-op for non-.mjs files, missing files, or unparseable input —
// same "never crash the run" philosophy as lib/.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

const input = await readStdin();
let evt; try { evt = JSON.parse(input || '{}'); } catch { process.exit(0); }

const file = evt?.tool_input?.file_path;
if (!file || !file.endsWith('.mjs') || !existsSync(file)) process.exit(0);

// Workflow-DSL files (lib/*-workflow.mjs) use harness globals + top-level return/await,
// which a standalone `node --check` rejects. Wrap them in an async IIFE so real syntax
// errors are still caught without false-positives on the legal-in-workflow constructs.
// Reading the file can fail (race: vanishes after existsSync; I/O error) — degrade to a
// no-op rather than crash the hook, per the never-crash-mid-run rule.
let src, isWorkflow = false;
try {
  src = readFileSync(file, 'utf8');
  isWorkflow = file.endsWith('-workflow.mjs') && /\bexport const meta\b/.test(src);
} catch { process.exit(0); }

let target = file;
let tmpFile = null;
if (isWorkflow) {
  // Strip every top-level export (not just `export const meta`) so a future workflow
  // file with other top-level exports does not false-positive in the wrapped check.
  const wrapped = `${src.replace(/^export\s+/gm, '')}\n`;
  tmpFile = join(tmpdir(), `acr-wfcheck-${process.pid}.mjs`);
  // The tmp write can fail (disk full, permissions) — degrade to a no-op, do not crash.
  try {
    writeFileSync(tmpFile, `const args = '{}';\nconst phase = () => {}, log = () => {}, agent = async () => ({}), parallel = async () => [], pipeline = async () => [];\n(async () => {\n${wrapped}\n})();\n`);
  } catch { process.exit(0); }
  target = tmpFile;
}

try {
  execFileSync('node', ['--check', target], { stdio: ['pipe', 'pipe', 'pipe'] });
  if (tmpFile) rmSync(tmpFile, { force: true });
  process.exit(0);
} catch (e) {
  if (tmpFile) rmSync(tmpFile, { force: true });
  const msg = (e.stderr?.toString() || e.message || 'syntax error').trim();
  process.stderr.write(`syntax-check: ${file} does not parse\n${msg}\n`);
  process.exit(2);
}
