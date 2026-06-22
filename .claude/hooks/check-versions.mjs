#!/usr/bin/env node
// Hook (PostToolUse, Edit|Write|MultiEdit): the plugin version lives in four spots
// and they MUST agree. Source of truth: .claude-plugin/plugin.json $.version.
// Mirrors: package.json $.version, marketplace.json $.metadata.version and
// $.plugins[0].version. When a manifest is edited, re-read all four and flag drift
// (exit 2, message on stderr → fed back to the model). Degrades to a no-op for
// unrelated files or unreadable input. Use /release-plugin to bump them together.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(''));
  });
}

const MANIFESTS = ['package.json', 'plugin.json', 'marketplace.json'];

// Read each version-bearing field; missing/unparseable files contribute no entry
// rather than crashing the hook.
export function collectVersions(root) {
  const out = [];
  const read = (rel) => { try { return JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return null; } };

  const plugin = read('.claude-plugin/plugin.json');
  if (plugin?.version) out.push({ at: '.claude-plugin/plugin.json $.version', value: plugin.version });

  const pkg = read('package.json');
  if (pkg?.version) out.push({ at: 'package.json $.version', value: pkg.version });

  const mkt = read('.claude-plugin/marketplace.json');
  if (mkt?.metadata?.version) out.push({ at: 'marketplace.json $.metadata.version', value: mkt.metadata.version });
  if (mkt?.plugins?.[0]?.version) out.push({ at: 'marketplace.json $.plugins[0].version', value: mkt.plugins[0].version });

  return out;
}

export function drift(versions) {
  const distinct = [...new Set(versions.map((v) => v.value))];
  return distinct.length > 1 ? distinct : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = await readStdin();
  let evt; try { evt = JSON.parse(input || '{}'); } catch { process.exit(0); }

  const file = evt?.tool_input?.file_path ?? '';
  if (!MANIFESTS.some((m) => file.endsWith(m))) process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || evt?.cwd || process.cwd();
  const versions = collectVersions(root);
  const mismatch = drift(versions);
  if (mismatch) {
    const lines = versions.map((v) => `  ${v.value}  ←  ${v.at}`).join('\n');
    process.stderr.write(`check-versions: plugin version is out of sync (${mismatch.join(' vs ')}):\n${lines}\nBump all four together (source of truth: plugin.json) — see /release-plugin.\n`);
    process.exit(2);
  }
  process.exit(0);
}
