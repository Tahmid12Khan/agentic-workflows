# Doctrine: change sizing

A change's *size and coherence* affect how reviewable — and how safe — it is. This is advisory context; the deterministic process-advisory in the report already flags raw size. Your job is the judgment the counter can't make.

**Rules of thumb.** ~100 changed lines is a comfortable review; ~300 is fine *if it is one logical change*; ~1000+ almost always should have been split. Size alone is not a defect — a mechanical rename touching 40 files is trivial to review; a 120-line change that mixes three concerns is not.

**One logical change per change.** A change that both *refactors* and *adds a feature* is two changes wearing one hat — the refactor hides the feature's real diff and vice versa. Call this out: recommend landing the refactor first, then the feature on top, so each is reviewable and revertable on its own.

**Splitting strategies** (suggest the one that fits):
- **Stacked** — dependent steps as a chain of small changes, each building on the last.
- **By file-group** — independent subsystems touched together split along their seams.
- **Horizontal** — one layer at a time (schema → data access → API → UI).
- **Vertical** — one thin end-to-end slice of the feature, then the next.

**Exemptions.** Pure deletions and mechanical renames don't count against size — they're low-risk and quick to read even when large. Generated/vendored churn (already stripped from the reviewed diff) never counts.

Frame size feedback as `suggestion` severity and *process* advice — it never blocks a merge. Focus the actual review on correctness regardless of size.
