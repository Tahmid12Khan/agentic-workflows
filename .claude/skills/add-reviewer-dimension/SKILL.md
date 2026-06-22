---
name: add-reviewer-dimension
description: Scaffold a new review dimension (Dxx) for the adversarial-code-review plugin end to end — the reviewer agent, its triage.mjs wiring, model/gate selection, and the doc updates. Use when adding a new review concern (a new D-number / new agents/*-reviewer.md).
---

# Add a review dimension

A dimension is one review concern (the `Dn` ids). Adding `Dxx` means: write the reviewer agent, register it in `lib/triage.mjs`, decide when it runs, and update the docs. Nothing in `config.schema.json` or `render.mjs` needs editing — `render.mjs` imports the maps from `triage.mjs` and reflects new dimensions automatically.

Pick the next free D-number — check `DIMENSION_LABELS` in `lib/triage.mjs` for the highest in use. Then do every step.

## 1. Write the agent

Copy `template-reviewer.md` (in this skill dir) to `agents/<name>-reviewer.md`. It is a verbatim copy of the canonical reviewer shape (see `agents/a11y-i18n-reviewer.md`, the cleanest recent precedent). Fill in:

- Frontmatter: `name: <name>-reviewer` (kebab-case, == filename), one-line `description` ending `Advisory only.`, `model:` (`sonnet` default; `opus` for hard-reasoning dims; `haiku` for the lightest), `tools: Read, Grep, Glob, Bash`.
- Body `Focus — Dxx <label> on the changed lines:` with 4–6 specific checks.
- Keep the **SHARED RULES** block and the **OUTPUT JSON** contract verbatim — they are load-bearing. The finding's `"dimension"` must be `"Dxx"`, severity stays in the 4-value vocab (`critical|important|minor|suggestion`), evidence must cite `file:line`, and the `confidence >= 80` / `uncertain` gate must remain.

## 2. Register it in `lib/triage.mjs`

- `DIMENSION_AGENTS` (lines ~29–44): add `Dxx: '<name>-reviewer',` — the string MUST equal the agent's `name:` frontmatter.
- `DIMENSION_LABELS` (lines ~46–52): add `Dxx: '<short human label>',` — this is the only label source.

## 3. Decide when it runs (`lib/triage.mjs`)

Two mechanisms — use one or both:

- **Tier-based** — add `Dxx` to one or more tiers in `TIER_DIMENSIONS` (lines ~16–22) to run it always at that tier.
- **Content-gated** — add a line in `planReview()` (lines ~77–85): `if (signals.<flag>) dims.add('Dxx');` to fire only when the diff has a relevant signal.

If the gate needs a signal that doesn't exist, add it to `computeSignals()` in `lib/signals.mjs`, deriving it from file paths or diff content. If it keys off diff content (not just paths), also add the regex/field to the `change` object in `lib/plan.mjs` (lines ~53–75), since `computeSignals` only sees what `plan.mjs` passes it. Reuse an existing signal (`uiTouched`, `perfSensitive`, …) when you can.

## 4. Model (`lib/triage.mjs`)

If the agent's `model:` is `opus`, add `'Dxx'` to `OPUS_DIMS` (line ~24) so `plan.models` agrees with the frontmatter. Skip if it uses the tier model.

## 5. Optional wiring

- `lib/route.mjs` `CHECK_DIM` (lines ~19–26): add `[/regex/i, 'Dxx']` if a config `mandatory_checks` phrase should auto-tag to your dimension. (`route.mjs` never decides which dimensions run.)
- `agents/triage-classifier.md`: mention `Dxx` in its `addDimensions` guidance if you want the LLM triage pass to be able to add it when the gates miss it.

## 6. Update the docs (run `/sync-docs` or do manually)

- `README.md`: add the `| Dxx <label> | <name>-reviewer | <model> |` row to the **Dimensions & agents** table; bump every dimension-count and agent-count claim (grep both docs for the old number) in the intro, "What it does", "Layout", and Roadmap.
- `docs/ARCHITECTURE.md`: add the row to **The agents (23 bundled)** dimension table (and the heading agent count); update **Step 3 — dimensions, then models** (the `TIER_DIMENSIONS` table and the content-gates list); if you added a verify lens, update **Bounded adversarial verification**.

## 7. Add a test and verify

- Extend `tests/triage.test.mjs` (or `tests/v2.test.mjs`): on a signal/tier that triggers `Dxx`, assert `planReview(...).dimensions` includes `Dxx`, `dimensionAgents[Dxx]` is your agent, and `models[Dxx]` is set.
- Run `node lib/plan.mjs --dimensions Dxx` and confirm the JSON plan shows `Dxx` in `dimensions`, your agent in `agents`, `dimensionAgents[Dxx]`, `dimensionLabels[Dxx]`, and a model in `models[Dxx]`. (The always-on trio D1/D2/D12 is force-added on the `--dimensions` path — your `Dxx` should appear alongside them.)
- `npm test` — all green.

## Checklist

- [ ] `agents/<name>-reviewer.md` written from the template, finding contract intact
- [ ] `DIMENSION_AGENTS` + `DIMENSION_LABELS` entries (name matches frontmatter)
- [ ] Run-condition wired (`TIER_DIMENSIONS` and/or `planReview()` gate; signal added if needed)
- [ ] `OPUS_DIMS` updated iff agent model is opus
- [ ] README + ARCHITECTURE updated (counts + tables) — `/sync-docs`
- [ ] Test added; `npm test` green; `node lib/plan.mjs --dimensions Dxx` confirms the plan
