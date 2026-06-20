#!/usr/bin/env node
// CLI: run real dependency/supply-chain scanners when available and turn their
// output into D15 findings. Advisory; degrades to a skip note if no tool/manifest.
// Usage: node scan.mjs            (auto-detect from cwd)
// Prints { findings:[...], notes:[...] } to stdout.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function sh(cmd, args) { return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 }).toString(); }
function tryRun(cmd, args) { try { return sh(cmd, args); } catch (e) { return e.stdout ? e.stdout.toString() : null; } } // audit tools exit non-zero when vulns exist
function have(cmd) { try { sh(cmd, ['--version']); return true; } catch { return false; } }

const SEV = { critical: 'critical', high: 'high', important: 'important', moderate: 'minor', low: 'minor', info: 'suggestion' };

// --- pure parsers (exported for tests) ---
export function parseNpmAudit(json) {
  let data; try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const out = [];
  const vulns = data.vulnerabilities ?? {};
  for (const [name, v] of Object.entries(vulns)) {
    out.push({
      dimension: 'D15', severity: SEV[v.severity] ?? 'minor',
      file: 'package.json', line: 0,
      title: `Vulnerable dependency: ${name} (${v.severity})`,
      evidence: Array.isArray(v.via) ? v.via.map((x) => (typeof x === 'string' ? x : x.title)).filter(Boolean).join('; ') : String(v.via ?? ''),
      fix: v.fixAvailable ? 'run npm audit fix (or bump to a patched version)' : 'no fix published — pin/replace or accept risk explicitly',
      confidence: 95, source: 'npm audit',
    });
  }
  return out;
}

export function parsePipAudit(json) {
  let data; try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const deps = Array.isArray(data) ? data : (data.dependencies ?? []);
  const out = [];
  for (const d of deps) for (const vuln of d.vulns ?? []) {
    out.push({
      dimension: 'D15', severity: 'important',
      file: 'requirements.txt', line: 0,
      title: `Vulnerable dependency: ${d.name} ${d.version} (${vuln.id})`,
      evidence: vuln.description ? vuln.description.slice(0, 200) : vuln.id,
      fix: vuln.fix_versions?.length ? `upgrade to ${vuln.fix_versions.join('/')}` : 'no fix published',
      confidence: 95, source: 'pip-audit',
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const findings = [], notes = [];
  if (existsSync('package.json') && have('npm')) {
    const out = tryRun('npm', ['audit', '--json']);
    if (out) { const f = parseNpmAudit(out); findings.push(...f); notes.push(`npm audit: ${f.length} advisory`); }
    else notes.push('npm audit produced no output');
  } else if (existsSync('requirements.txt') && have('pip-audit')) {
    const out = tryRun('pip-audit', ['-f', 'json']);
    if (out) { const f = parsePipAudit(out); findings.push(...f); notes.push(`pip-audit: ${f.length} advisory`); }
  } else if (existsSync('pom.xml') || existsSync('build.gradle')) {
    notes.push('Java project — run OWASP dependency-check / `mvn verify` in CI; not auto-run here');
  } else {
    notes.push('no supported manifest + scanner found — dependency scan skipped');
  }
  process.stdout.write(JSON.stringify({ findings, notes }, null, 2) + '\n');
}
