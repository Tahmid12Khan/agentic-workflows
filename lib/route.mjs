#!/usr/bin/env node
// Deterministic routing the orchestrator used to do in prose:
//  1. which intent groups need EXTRA scrutiny (scope-creep / unexplained change),
//  2. mandatory_checks turned into forced review items mapped to a dimension,
//  3. a per-aspect spawn ledger (exposed as `route.mjs spawn`) so the
//     "<=N subagents per aspect" cap is decided by this code path — the
//     orchestrator threads the ledger through each dispatch and stops on ok:false.
// Pure helpers below; thin CLI at the bottom.

// --- 1. extra-intent scrutiny ---
export function extraScrutinyTargets(grouperOutput = {}) {
  const groups = grouperOutput.groups ?? [];
  return groups
    .filter((g) => g.scrutinize === true || (g.kind === 'extra' && g.withinScope === false))
    .map((g) => ({ label: g.label ?? 'extra', files: g.files ?? [], reason: g.note || 'change beyond the stated scope' }));
}

// --- 2. mandatory checks → forced review items + a best-guess dimension ---
const CHECK_DIM = [
  [/secret|token|credential|\bkey\b|password/i, 'D3'],
  [/inject|sql|xss|ssrf|saniti|validat|escap|authz|authoriz|\bauth\b|input/i, 'D3'],
  [/test|coverage|\bspec\b/i, 'D5'],
  [/migrat|rollback|reversible|backfill|index|transaction/i, 'D6'],
  [/log|\bpii\b|trace|metric|observ/i, 'D14'],
  [/licen|dependenc|\bcve\b|supply.?chain|pin(ned|ning)?/i, 'D15'],
];
export function forcedChecks(mandatoryChecks = []) {
  return (mandatoryChecks ?? []).map((check) => {
    const hit = CHECK_DIM.find(([re]) => re.test(check));
    return { check, dimension: hit ? hit[1] : null };
  });
}

// --- 3. per-aspect spawn ledger (decides the <=N-subagents-per-aspect cap in code) ---
// aspectKey examples: "review:D3:shardA", "verify:src/auth.ts:42", "doubt:concurrency"
export function newLedger() { return {}; }
export function aspectCount(ledger, key) { return ledger[key] ?? 0; }
export function canSpawn(ledger, key, max = 3) { return aspectCount(ledger, key) < max; }
export function recordSpawn(ledger, key, max = 3) {
  if (!key) return { ok: false, count: 0, capped: false, error: 'missing aspect key' }; // never merge unrelated aspects into one bucket
  const cur = aspectCount(ledger, key);
  if (cur >= max) return { ok: false, count: cur, capped: true };
  ledger[key] = cur + 1;
  return { ok: true, count: cur + 1, capped: false };
}

// --- CLI: route.mjs scrutiny | route.mjs checks | route.mjs spawn  (JSON on stdin) ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  const input = await new Promise((r) => { let b = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (b += d)); process.stdin.on('end', () => r(b)); });
  const data = JSON.parse(input || '{}');
  if (cmd === 'scrutiny') {
    process.stdout.write(JSON.stringify({ targets: extraScrutinyTargets(data) }, null, 2) + '\n');
  } else if (cmd === 'checks') {
    process.stdout.write(JSON.stringify({ checks: forcedChecks(data.mandatoryChecks ?? data) }, null, 2) + '\n');
  } else if (cmd === 'spawn') {
    // Per-aspect spawn gate. The orchestrator threads the returned ledger back into
    // the next call, so the <=N-subagents-per-aspect cap is decided by this code path
    // (ok:false when capped), not by the model's discretion. stdin: {ledger,key,max}.
    const ledger = data.ledger ?? {};
    const res = recordSpawn(ledger, data.key, data.max ?? 3);
    process.stdout.write(JSON.stringify({ ...res, key: data.key, ledger }, null, 2) + '\n');
  } else {
    console.error('usage: route.mjs scrutiny|checks|spawn  (JSON on stdin)');
    process.exit(2);
  }
}
