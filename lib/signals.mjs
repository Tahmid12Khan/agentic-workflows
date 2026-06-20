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
