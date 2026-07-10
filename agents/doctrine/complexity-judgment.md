# Doctrine: complexity judgment

Complexity is not a smell by itself — *unearned* complexity is. Use these tests before flagging.

**Relocation vs reduction.** Count the concepts the reader must hold at once to understand the changed code. An abstraction that lowers that count earns its keep; one that only moves the hard part behind a name the reader must *also* learn has added complexity while looking like it removed some. Flag the second, not the first.

**Abstractions must earn their cost.** No generalization before the third real use. A framework/base-class/config-knob introduced for a single call site is speculative — it costs indirection now against a benefit that may never arrive. "You might need it later" is not a reason; "three places do this today" is.

**Bolted-on conditionals in unrelated flows.** A new `if (specialCase)` threaded through a function that had nothing to do with that case is a design smell — the flow now carries knowledge it shouldn't. Prefer handling the special case at the boundary, or behind a seam, over widening a general path with a narrow branch.

**File-size growth is a signal, not a rule.** When a changed file crosses ~800–1000 total lines, treat it as a prompt to ask whether a decomposition is overdue — suggest the seam (by responsibility, not by line count). It is advice, never a gate; a cohesive 1200-line file beats four incoherent 300-line ones.

**Depth over length.** Deep nesting (guard-clause candidates, arrow-code) taxes the reader more than raw line count. An early return or a small extracted predicate usually beats another level of indentation.

Ground each judgment in `file:line`. Prefer proposing the specific restructuring (see structural remedies) over a bare "this is complex."
