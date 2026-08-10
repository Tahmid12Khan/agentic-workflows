#!/usr/bin/env node
// CLI: PreToolUse hook — decide whether a Bash command from one of THIS PLUGIN'S review agents is
//      read-only, and deny it otherwise.
// Usage: wired by hooks/hooks.json; reads the PreToolUse payload as JSON on stdin.
//   Prints a PreToolUse hookSpecificOutput decision on stdout, or NOTHING (stay neutral).
//
// WHY THIS EXISTS. Every reviewer now has Bash so it can pull the context it needs (`git log` on a
// changed file, `rg` for a caller) instead of the pipeline pre-computing a context pack for every run
// whether it gets used or not — push became pull. But golden rule 1 says no lib/ module and no agent
// may author or persist a change to a reviewed file, and Bash is the one tool that could. The
// allowlist below is what keeps that invariant true by construction rather than by prompt wording.
//
// TWO SAFETY DIRECTIONS, both deliberate:
//   1. For a review agent → DENY BY DEFAULT. An unrecognized binary, any redirection, any command
//      substitution, any in-place edit is refused, because the cost of a reviewer silently mutating
//      the tree under review is far higher than the cost of it doing without one command.
//   2. For anyone else → STAY NEUTRAL (print nothing). A plugin-shipped hook fires for the WHOLE
//      session, and a deny-by-default rule applied to the user's own shell would break their work.
//      When the payload does not identify a caller from this plugin's roster we decide nothing and
//      the normal permission flow runs untouched.
// The second rule also means the guard fails OPEN if a harness version stops reporting the subagent
// in the payload — reviewers then fall back to ordinary Bash permission prompts. That is the right
// failure direction for an advisory tool: never wedge the user's session to enforce our own policy.
// Set ACR_BASH_GUARD=all to apply the allowlist to every Bash call (useful to verify the rules),
// or ACR_BASH_GUARD=off to disable the hook entirely.

import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// git subcommands that only ever READ history or the index. Deliberately excludes anything that can
// write a ref, an object, the index, or the working tree (add/commit/checkout/restore/stash/apply/
// am/rebase/merge/reset/clean/push/fetch/gc/worktree/notes/replace/update-*/mv/rm).
export const GIT_READ_SUBCOMMANDS = new Set([
  'show', 'log', 'diff', 'blame', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse',
  'rev-list', 'describe', 'shortlog', 'grep', 'status', 'show-ref', 'merge-base', 'symbolic-ref',
  'name-rev', 'whatchanged', 'count-objects', 'var', 'help',
]);

// Non-git binaries a reviewer may run. Every one reads and writes only to stdout; the redirection
// and substitution bans below are what stop that stdout from becoming a file.
export const READ_ONLY_COMMANDS = new Set([
  'rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack',
  'cat', 'head', 'tail', 'nl', 'wc', 'sort', 'uniq', 'cut', 'tr', 'comm', 'column', 'fold', 'rev',
  'ls', 'find', 'file', 'stat', 'basename', 'dirname', 'realpath', 'readlink', 'tree', 'du', 'pwd',
  'echo', 'printf', 'true', 'false', 'test', 'date', 'seq', 'jq', 'yq', 'diff', 'cmp', 'md5sum',
  'sed', 'awk', 'gawk', 'mawk',
]);

// Per-command argument bans: flags that turn an otherwise read-only tool into a writer or an
// arbitrary-code executor. Checked against every argument of a matching segment.
const ARG_BANS = {
  // -i rewrites in place; -f runs a script FILE whose contents we cannot inspect here
  sed: [/^-{1,2}i/, /^--in-place/, /^-f$/, /^--file/, /^--expression=.*\bw\s/],
  find: [/^-exec(dir)?$/, /^-ok(dir)?$/, /^-delete$/, /^-f(print|printf|ls)$/],
  git: [/^--output/, /^-c$/, /^--exec-path=/, /^--ext-diff$/, /^-O/], // -c injects core.pager/sshCommand → exec
  awk: [/^-f$/, /^--file/], gawk: [/^-f$/, /^--file/], mawk: [/^-f$/, /^--file/],
};

// awk and sed can both write a file and (awk) shell out from INSIDE their PROGRAM text, where no
// argument scan would see it — `awk '{system("rm -rf /")}'`, `sed -n '1,10w /tmp/stolen'`. The
// program is the one argument we have to look into.
const AWK_BANS = [/\bsystem\s*\(/, /\bprint\b[^;}]*>/, /\bprintf\b[^;}]*>/, /\|\s*&?\s*"/, /\bclose\s*\(/];
// sed's `w file` command and the `s///w file` flag are the only ways a sed program writes. A write
// `w` always follows an ADDRESS — a digit ("1,10w out"), a `/regex/`, a `}`, or nothing — never a
// letter, which is what a literal w inside a word looks like ("two words", "raw file"). \b is not
// enough: it does not fire between "0" and "w". Erring toward a false deny is the safe direction.
const SED_BANS = [/(^|[^A-Za-z])[wW]\s+\S/];

// Shell metacharacters that can smuggle a write past a per-segment allowlist check: redirection
// (turns any read into a file write) and command substitution (runs an arbitrary second command).
// `2>&1` and `2>/dev/null` are the two benign redirections a model actually uses, so they are
// stripped before the scan rather than rejected.
export function scrubBenignRedirects(cmd) {
  return String(cmd ?? '').replace(/\d?>\s*&\s*\d/g, ' ').replace(/\d?>\s*\/dev\/null/g, ' ');
}

// Pure: split a command line into the segments a shell would run, on ; && || | and newlines, while
// ignoring separators inside single or double quotes. Not a full shell parser — it does not need to
// be, because anything it cannot account for (substitution, redirection) is banned outright above.
export function splitSegments(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  const s = String(cmd ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote && s[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\n' || c === ';') { out.push(cur); cur = ''; continue; }
    if ((c === '&' || c === '|') && s[i + 1] === c) { out.push(cur); cur = ''; i++; continue; }
    // A SINGLE & is a separator too, not just a trailing background marker: `git log & rm -rf src`
    // would otherwise leave `rm -rf src` inside an allowlisted segment, unchecked.
    if (c === '|' || c === '&') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// Pure: quote-aware argv split of ONE segment, with the quotes removed from each token.
export function tokenize(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  const s = String(segment ?? '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== '\\') { quote = null; continue; }
      cur += c; started = true; continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started || cur) { out.push(cur); cur = ''; started = false; } continue; }
    cur += c; started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

// Pure: is ONE segment a read-only command? Returns null when it is, or a human-readable reason when
// it is not. Leading VAR=value assignments and an `env` prefix are skipped so `LC_ALL=C rg foo` works.
export function checkSegment(segment) {
  const tokens = tokenize(segment);
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === 'env')) i++;
  const argv = tokens.slice(i);
  if (!argv.length) return null;                       // bare assignment / empty → nothing runs
  const cmd = argv[0].split('/').pop();                // allow /usr/bin/rg as rg
  const args = argv.slice(1);

  if (cmd === 'git') {
    for (const a of args) {
      if (ARG_BANS.git.some((re) => re.test(a))) return `git flag "${a}" can execute or write`;
    }
    // skip read-only global flags (-C <dir>, --no-pager, --git-dir=…) to reach the subcommand
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) { if (args[j] === '-C') j++; j++; }
    const sub = args[j];
    if (!sub) return null;                              // bare `git` prints usage
    if (!GIT_READ_SUBCOMMANDS.has(sub)) return `git subcommand "${sub}" is not read-only`;
    return null;
  }

  if (!READ_ONLY_COMMANDS.has(cmd)) return `"${cmd}" is not on the read-only allowlist`;
  for (const re of ARG_BANS[cmd] ?? []) {
    const bad = args.find((a) => re.test(a));
    if (bad) return `${cmd} flag "${bad}" can execute or write`;
  }
  if (cmd === 'awk' || cmd === 'gawk' || cmd === 'mawk') {
    const program = args.find((a) => !a.startsWith('-')) ?? '';
    if (AWK_BANS.some((re) => re.test(program))) return 'awk program can write a file or shell out';
  }
  if (cmd === 'sed') {
    // every non-flag arg is a candidate program (sed takes the script as the first operand, or one
    // per -e), so scan them all rather than guessing which one it is
    const bad = args.filter((a) => !a.startsWith('-')).find((a) => SED_BANS.some((re) => re.test(a)));
    if (bad) return `sed program "${bad}" writes a file (w command)`;
  }
  return null;
}

// Pure: the allow/deny decision for a whole command line. Deny wins on the FIRST failing segment so
// the reason names the actual offender.
export function classify(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return { decision: 'allow', reason: 'empty command' };
  const scrubbed = scrubBenignRedirects(raw);
  // `cmd`, $(cmd) and <(cmd) all run a second command whose text never reaches the segment scan
  if (/[`]|\$\(|<\(/.test(scrubbed)) return { decision: 'deny', reason: 'command substitution can run anything — not allowed for an advisory reviewer' };
  if (/>/.test(scrubbed)) return { decision: 'deny', reason: 'output redirection would write a file — this reviewer is advisory and never writes' };
  // No separate background check: splitSegments treats a single & as a separator, so `cmd &` is just
  // `cmd` and is judged on its own merits — backgrounding a read is harmless, and anything AFTER the
  // & is a segment that has to pass on its own.
  for (const seg of splitSegments(scrubbed)) {
    const bad = checkSegment(seg);
    if (bad) return { decision: 'deny', reason: `${bad}. This plugin is advisory: reviewers may only READ (git show/log/diff/blame, rg, grep, sed -n, find, cat/head/tail, jq).` };
  }
  return { decision: 'allow', reason: 'read-only' };
}

// The plugin's own agent roster, read from agents/*.md next to this file, so a new reviewer is
// covered the moment it is added and nothing has to be kept in sync by hand.
export function pluginAgents(agentsDir) {
  try {
    return new Set(readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
  } catch { return new Set(); }
}

// Pure: does this PreToolUse payload come from one of our agents? The harness has carried the
// subagent identity under several different keys across versions, and may not carry it at all, so
// scan the payload (shallow + one nested level) for ANY string that names an agent on the roster.
// Returns the matched name, or null → the caller stays neutral (see the header: fail open).
export function callerAgent(payload, roster) {
  const seen = [];
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 1) return;
    for (const v of Object.values(obj)) {
      if (typeof v === 'string') seen.push(v);
      else if (v && typeof v === 'object') visit(v, depth + 1);
    }
  };
  visit(payload, 0);
  for (const v of seen) {
    const name = v.includes(':') ? v.slice(v.lastIndexOf(':') + 1) : v;   // "adversarial-code-review:vuln-reviewer"
    if (roster.has(name)) return name;
  }
  return null;
}

// Pure: the full hook decision. Returns null to stay NEUTRAL (emit nothing).
export function decide(payload, roster, { force = false } = {}) {
  if ((payload?.tool_name ?? payload?.toolName) !== 'Bash') return null;
  const command = payload?.tool_input?.command ?? payload?.toolInput?.command;
  if (typeof command !== 'string') return null;
  const agent = callerAgent(payload, roster);
  if (!agent && !force) return null;              // not ours → never touch the user's own session
  const { decision, reason } = classify(command);
  return { decision, reason, agent: agent ?? '(forced)' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.env.ACR_BASH_GUARD ?? '';
  if (mode === 'off') process.exit(0);
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch { process.exit(0); }   // unparseable → neutral, never block
  const agentsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'agents');
  const out = decide(payload, pluginAgents(agentsDir), { force: mode === 'all' });
  if (!out) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: out.decision,
      permissionDecisionReason: `[adversarial-code-review/${out.agent}] ${out.reason}`,
    },
  }) + '\n');
}
