# Doctrine: structural remedies

When code is hard to follow, name the *restructuring* — don't just say "this is complex." A remedy the author can act on is worth ten "consider simplifying"s. Reach for these named moves:

- **Replace a conditional chain with a dispatcher.** A growing `if/else`/`switch` on a type or string tag → a lookup table / map of handlers / polymorphism. Each new case then adds data, not a branch.
- **Collapse duplicate branches.** When two arms of a conditional differ only in a value, hoist the shared code and vary the value. When several `catch`/error arms do the same thing, merge them.
- **Separate orchestration from business logic.** A function that both *decides* (policy, thresholds, ordering) and *does* (I/O, mutation) is two functions. Split so the decision is pure and testable and the effectful part is thin.
- **Move feature logic out of shared modules.** A `switch (feature)` or `if (tenant === …)` bolted into a shared/util module is a design smell — the shared code now knows about a caller. Push the special case up to the caller or behind an interface.
- **Delete pass-through wrappers.** A function/class that only forwards to another with no added value is indirection tax. Inline it unless it marks a real seam (a boundary you'd mock, a stable public API).
- **Make type boundaries explicit.** Replace a bag of loosely-related params (or a stringly-typed field) with a named type that states the contract. Parse-don't-validate at the edge so the interior can't hold an illegal value.

**Relocation vs reduction.** Ask whether the change *reduces* total complexity or just *moves* it somewhere less visible. Pushing a hard case into a helper the reader must also hold in their head is not a simplification — it's a hidden cost. A real remedy lowers the number of concepts the reader carries at once.

Phrase every remedy as a concrete suggestion tied to `file:line`. You are advisory — you propose, you never edit.
