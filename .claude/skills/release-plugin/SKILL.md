---
name: release-plugin
description: Cut a release of the adversarial-code-review plugin — bump the version across every manifest that carries it, update RELEASES.md (and ROADMAP.md when scope shifts), run tests, commit and tag. Use when shipping a new version.
disable-model-invocation: true
---

# Release the plugin

The version is duplicated across several manifests and they must agree. **Source of truth: `.claude-plugin/plugin.json` `$.version`** (the manifest the plugin runtime reads). The `check-versions` hook flags drift, so all of these have to move together.

Ask for the new version (semver) if not given. Then:

## 1. Bump the version everywhere

Set the same value in all of:

- `.claude-plugin/plugin.json` → `$.version`  *(source of truth)*
- `package.json` → `$.version`
- `.claude-plugin/marketplace.json` → `$.metadata.version`
- `.claude-plugin/marketplace.json` → `$.plugins[0].version`

(If a `.claude-plugin/plugin.json` field is ever added/removed elsewhere, re-check `.claude/hooks/check-versions.mjs` — it enumerates the locations it validates.)

## 2. Update the changelog surface

The release log is **`RELEASES.md`** (newest first); the forward-looking plan is **`ROADMAP.md`**. Add a `## v<new>` section at the top of `RELEASES.md` describing what shipped; if the release delivered anything that was listed under `ROADMAP.md` "Next", remove those bullets from `ROADMAP.md`. Also update any "v<old> adds…" prose in the README Configuration section to reflect what this release adds. (`README.md` only links to these two files — do not re-add a Roadmap section there.)

## 3. Reconcile the docs

Run `/sync-docs` (or do it by hand) so `README.md` and `docs/ARCHITECTURE.md` match the code shipping in this release — especially agent/dimension tables and config keys if they changed.

## 4. Verify

- `npm test` — must be green.
- Confirm version sync: `node .claude/hooks/check-versions.mjs` reads its locations; or just grep the four fields and eyeball that they match. No drift.

## 5. Commit and tag

Conventional Commits, no attribution trailers:

```
git add -A
git commit -m "chore(release): v<new>"
git tag v<new>
```

Push only when the user asks (`git push && git push --tags`). Don't push unprompted.

## Checklist

- [ ] Version identical in plugin.json, package.json, and both marketplace.json fields
- [ ] `RELEASES.md` has a `## v<new>` section; `ROADMAP.md` "Next" pruned of anything shipped
- [ ] `/sync-docs` run — README + ARCHITECTURE current
- [ ] `npm test` green; no version drift
- [ ] `chore(release): v<new>` commit + `v<new>` tag
