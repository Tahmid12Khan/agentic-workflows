# Doctrine: severity norms

Read this before ranking findings. It governs *what you lead with*, not the finding contract.

**Lead with leverage.** Correctness and security come first, always. A review's value is the one thing the author most needs to hear — surface it, don't bury it.

**One structural problem beats ten nits.** If a change has a single design flaw (wrong boundary, leaked invariant, missing authz) and ten cosmetic issues, the design flaw *is* the review. Report it first and say plainly that the nits are secondary. Never let a pile of `suggestion`s drown a `critical`.

**Don't manufacture severity.** A style preference is a `suggestion`, not `important`. Inflating severity to force attention destroys trust in the whole gate. Reserve `critical` for "this breaks / is exploitable" and `important` for "this is a real defect a maintainer must address."

**Quantify when you can.** "~50ms added per item on a 10k-row loop" beats "could be slow." "Unbounded: one request can open N connections" beats "possible leak." A number or a concrete failing input turns a vague worry into an actionable finding — and lets the reader judge whether it matters at their scale.

**Group by cause, not by file.** Ten findings that are the same missing null-guard repeated are ONE finding with ten sites, not ten findings. Consolidate; cite every site in the evidence.

**A finding you can't ground is a question, not an assertion.** If you can't cite the failing path, emit it `uncertain:true` at your real confidence — the verifier will adjudicate. Do not assert to look thorough.
