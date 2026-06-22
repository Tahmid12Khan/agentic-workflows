#!/usr/bin/env node
// Hook (PostToolUse, Edit|Write|MultiEdit): node --check the edited .mjs file so a
// syntax error is caught the instant it is written, not when a review run crashes.
// Reads the hook JSON on stdin; exits 2 with a message on stderr if the file does
// not parse (Claude Code feeds stderr back to the model), exits 0 otherwise.
// Degrades to a no-op for non-.mjs files, missing files, or unparseable input —
// same "never crash the run" philosophy as lib/.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

try {
  execFileSync('node', ['--check', file], { stdio: ['pipe', 'pipe', 'pipe'] });
  process.exit(0);
} catch (e) {
  const msg = (e.stderr?.toString() || e.message || 'syntax error').trim();
  process.stderr.write(`syntax-check: ${file} does not parse\n${msg}\n`);
  process.exit(2);
}
