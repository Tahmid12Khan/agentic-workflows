// Pure: derive cheap classification signals from diff metadata.
const RISK_PATTERNS = [
  ['auth', /(^|\/)auth(\/|\.|$)|(^|\/)(login|session|oauth|jwt|permission|rbac)(\/|\.|$)/i],
  ['payment', /(^|\/)(payment|billing|checkout|invoice|charge|refund)(\/|\.|$)/i],
  ['migration', /migration|\.sql$|flyway|liquibase|alembic|knex|prisma\/migrations/i],
  ['crypto', /crypto|cipher|encrypt|decrypt|signature|hmac|pbkdf|bcrypt/i],
  ['infra', /(^|\/)(infra|deploy|k8s|helm)\/|Dockerfile|\.tf$|\.ya?ml$/i],
  ['secrets', /secret|credential|\.env|api[_-]?key/i],
];
const DOC_EXT = /\.(md|mdx|txt|rst|adoc)$/i;
const UI_EXT = /\.(tsx|jsx|vue|svelte|html|htm|css|scss|less)$/i;

export function computeSignals(change) {
  const files = change.files ?? [];
  const riskPaths = RISK_PATTERNS
    .filter(([, re]) => files.some(f => re.test(f)))
    .map(([name]) => name);
  return {
    fileCount: files.length,
    netLoc: change.netLoc ?? 0,
    docOnly: files.length > 0 && files.every(f => DOC_EXT.test(f)),
    riskPaths,
    publicContract: !!change.publicContract,
    depsChanged: !!change.depsChanged,
    testsPresent: !!change.testsPresent,
    concurrencyTouched: !!change.concurrencyTouched,
    errorHandlingTouched: !!change.errorHandlingTouched,
    typesTouched: !!change.typesTouched,
    perfSensitive: !!change.perfSensitive,
    uiTouched: files.some(f => UI_EXT.test(f)) || !!change.uiTouched,
    callsLlm: !!change.callsLlm,
    languages: [...new Set(files.map(extLang).filter(Boolean))],
    __files: files,
  };
}

// Pure (WS1): the change-SIZE process advisory — a deterministic, zero-model-cost signal computed
// from diff stats. `process` is an advisory finding class: it is NEVER gate-affecting and renders in
// its own "Process advisories" report section. Thresholds mirror doctrine/change-sizing.md (~300
// acceptable if one logical change / ~1000 split). Exemptions match agent-skills: a PURE DELETION
// (no added lines — low-risk, quick to read) and a change that is MOSTLY renames (rename count covers
// the changed files — mechanical) never trigger it. Returns [] when nothing to advise.
const CHANGE_SIZE_SOFT = 400;   // above the ~300 "acceptable if one logical change" band
const CHANGE_SIZE_HARD = 1000;  // "almost always should be split"
export function changeSizingAdvisory({ added = 0, deleted = 0, fileCount = 0, renames = 0 } = {}) {
  const changed = (Number(added) || 0) + (Number(deleted) || 0);
  if ((Number(added) || 0) === 0) return [];                          // pure deletion — exempt
  if (renames > 0 && renames >= fileCount) return [];                 // mostly mechanical renames — exempt
  if (changed >= CHANGE_SIZE_HARD) {
    return [{ kind: 'change-size', severity: 'suggestion',
      message: `Large change: ~${changed} changed lines across ${fileCount} file(s). A change this size almost always should be split (stacked / by file-group / horizontal / vertical — see doctrine/change-sizing). Advisory only; does not block the merge.` }];
  }
  if (changed >= CHANGE_SIZE_SOFT) {
    return [{ kind: 'change-size', severity: 'suggestion',
      message: `Sizable change: ~${changed} changed lines across ${fileCount} file(s). Fine if it is ONE logical change; if it mixes a refactor with a feature, consider landing them as two separate changes. Advisory only.` }];
  }
  return [];
}

// Pure: importable specifiers for a changed file — fed to `git grep` (in plan.mjs) to approximate
// its in-repo fan-in (blast radius). Two variants: the basename (most import/require calls reference
// a module by name, e.g. './config') and the full repo-relative path minus extension (deeper relative
// imports like '../lib/config'). This is a CHEAP heuristic, not exact import resolution — a common
// basename (e.g. 'index') can over-match. That's an acceptable tradeoff here: the result only feeds a
// tier ESCALATION (lib/triage.mjs), never a demotion, so a false positive costs one review tier, not a
// missed review.
export function moduleSpecifiers(file) {
  const noExt = file.replace(/\.[^./\\]+$/, '');
  const base = noExt.split('/').pop();
  return [...new Set([base, noExt])].filter(Boolean);
}

function extLang(f) {
  if (/\.java$/.test(f)) return 'java';
  if (/\.kt$/.test(f)) return 'kotlin';
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(f)) return 'ts';
  if (/\.py$/.test(f)) return 'python';
  if (/\.go$/.test(f)) return 'go';
  if (/\.rb$/.test(f)) return 'ruby';
  if (/\.rs$/.test(f)) return 'rust';
  if (/\.(cs)$/.test(f)) return 'csharp';
  if (/\.(php)$/.test(f)) return 'php';
  if (/\.sql$/.test(f)) return 'sql';
  return null;
}
