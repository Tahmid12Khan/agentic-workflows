#!/usr/bin/env node
// CLI: run the project's OWN test command (config `tests.command` — NEVER guessed) with a timeout
//      and turn the result into a compact pass/fail + failing-test-NAME signal (never the logs) for
//      the test-adequacy-reviewer (D5) packet and the report header. Feeding it via a script (like
//      scan.mjs) means the reviewer needs no Bash.
// Usage: node test-signal.mjs   (reads .adverserial-code-review/config.json → tests.command)
//   Prints one JSON object: { ran, passed, command, failing:[names], notes:[...] }. Off by default:
//   /review only runs this under --run-tests. It EXECUTES repo code — do NOT use on an untrusted PR.
//   Advisory + degrade-only: an unconfigured command / timeout / spawn error becomes a note + a
//   ran:false envelope, never a crash; it never edits source.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 600000;   // 10 min ceiling; overridable via tests.timeout_ms
const MAX_NAMES = 20;

// Pure: best-effort extraction of FAILING test NAMES from common runners' output (node:test / TAP,
// jest / vitest, pytest, go test). Names only — never the surrounding logs. De-duped and capped.
// An unrecognised format yields [] — the pass/fail bit still carries the signal.
export function parseFailingTests(output, max = MAX_NAMES) {
  const text = String(output ?? '');
  const names = new Set();
  const add = (n) => { const t = (n ?? '').trim(); if (t) names.add(t); };
  for (const m of text.matchAll(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/gm)) add(m[1]);   // node:test / TAP
  for (const m of text.matchAll(/^\s*[✕×✗]\s+(.+?)(?:\s+\(\d+\s*m?s\))?\s*$/gm)) add(m[1]); // jest / vitest
  for (const m of text.matchAll(/^FAILED\s+(\S+)/gm)) add(m[1]);                    // pytest
  for (const m of text.matchAll(/^---\s+FAIL:\s+(\S+)/gm)) add(m[1]);              // go test
  return [...names].slice(0, max);
}

// Pure: build the signal envelope from a run result. `passed` is null when the command never ran
// (unconfigured / spawn error) so a reviewer can tell "no test signal" from "tests failed".
export function testSignal({ ran, passed, command = null, output = '', notes = [] } = {}) {
  return {
    ran: !!ran,
    passed: ran ? !!passed : null,
    command: command ?? null,
    failing: (ran && !passed) ? parseFailingTests(output) : [],
    notes: notes ?? [],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let config = {};
  if (existsSync('.adverserial-code-review/config.json')) {
    try { config = JSON.parse(readFileSync('.adverserial-code-review/config.json', 'utf8')); } catch { /* ignore */ }
  }
  const command = config.tests?.command;
  const timeout = config.tests?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  let out;
  if (!command || typeof command !== 'string') {
    out = testSignal({ ran: false, notes: ['tests.command not configured — test execution skipped (never guessed)'] });
  } else {
    const notes = [];
    let passed, output = '';
    try {
      output = execSync(command, { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
      passed = true;
    } catch (e) {
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      passed = false;
      if (e.killed || e.signal === 'SIGTERM') notes.push(`test command timed out after ${timeout}ms`);
    }
    out = testSignal({ ran: true, passed, command, output, notes });
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
