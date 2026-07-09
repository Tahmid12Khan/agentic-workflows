#!/usr/bin/env node
// CLI: run the project's OWN test command (config `tests.command` — NEVER guessed) with a timeout
//      and turn the result into a compact pass/fail + failing-test-NAME signal (never the logs) for
//      the test-adequacy-reviewer (D5) packet and the report header. Feeding it via a script (like
//      scan.mjs) means the reviewer needs no Bash.
// Usage: node test-signal.mjs [--diff <path>]
//   Reads .adversarial-code-review/config.json → tests.command. With --diff, first checks whether
//   the reviewed range itself modifies the config file (current or legacy spelling) and, if so,
//   skips execution — see the untrusted-config guard below. Prints one JSON object:
//   { ran, passed, command, failing:[names], notes:[...] }. Off by default: /review only runs this
//   under --run-tests. It EXECUTES repo code — do NOT use on an untrusted PR without --diff.
//   Advisory + degrade-only: an unconfigured command / timeout / spawn error becomes a note + a
//   ran:false envelope, never a crash; it never edits source.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const DEFAULT_TIMEOUT_MS = 600000;   // 10 min ceiling; overridable via tests.timeout_ms
const MAX_NAMES = 20;
const CONFIG_PATHS = ['.adversarial-code-review/config.json', '.adverserial-code-review/config.json'];

// Pure: true if a unified diff touches the review config (current or legacy-typo spelling), checked
// via "diff --git"/"+++" header lines only. Cost of a miss: `tests.command` is a shell string read
// from the checked-out (possibly untrusted PR) tree — if a PR can edit it and still get it executed,
// that's arbitrary shell execution on the operator's machine (RCE), so callers gate exec on this.
export function diffModifiesConfig(diffText) {
  const text = String(diffText ?? '');
  return CONFIG_PATHS.some((p) => {
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^diff --git a/${esc} b/${esc}$`, 'm').test(text)
      || new RegExp(`^\\+\\+\\+ (?:b/)?${esc}(?:\\t.*)?$`, 'm').test(text);
  });
}

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

function arg(name, def) { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }

if (import.meta.url === `file://${process.argv[1]}`) {
  // WS9: `.adverserial-code-review` was a typo; `.adversarial-code-review` is correct. Prefer the
  // new name; fall back to the old one only if it's the ONLY one present — supports un-migrated
  // installs for one release cycle.
  const ACR_DIR = (existsSync('.adverserial-code-review') && !existsSync('.adversarial-code-review'))
    ? '.adverserial-code-review'
    : '.adversarial-code-review';
  let config = {};
  if (existsSync(`${ACR_DIR}/config.json`)) {
    try { config = JSON.parse(readFileSync(`${ACR_DIR}/config.json`, 'utf8')); } catch { /* ignore */ }
  }
  const command = config.tests?.command;
  const timeout = config.tests?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  const diffPath = arg('--diff');
  const notes = [];
  let configModified = false;
  if (diffPath) {
    try { configModified = diffModifiesConfig(readFileSync(diffPath, 'utf8')); }
    catch { notes.push(`--diff ${diffPath} could not be read — untrusted-config guard skipped`); }
  }

  let out;
  if (configModified) {
    out = testSignal({ ran: false, notes: ['tests.command not executed: .adversarial-code-review/config.json is modified in the reviewed range (untrusted-config guard)'] });
  } else if (!command || typeof command !== 'string') {
    out = testSignal({ ran: false, notes: [...notes, 'tests.command not configured — test execution skipped (never guessed)'] });
  } else {
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
