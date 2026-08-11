# Doctrine: severity norms

Read this before ranking findings. It governs *what you lead with*, not the finding contract.

**Lead with leverage.** Correctness and security come first. Surface the one thing the author most needs to hear — don't bury it.

**One structural problem beats ten nits.** A single design flaw (wrong boundary, leaked invariant, missing authz) alongside ten cosmetic issues *is* the review — report it first and call the nits secondary. Never let a pile of `suggestion`s drown a `critical`.

**Don't manufacture severity.** A style preference is a `suggestion`, not `important`. Inflating severity to force attention destroys trust in the gate. Reserve `critical` for "this breaks / is exploitable" and `important` for "a real defect a maintainer must address."

**Quantify when you can.** "~50ms added per item on a 10k-row loop" beats "could be slow." "Unbounded: one request can open N connections" beats "possible leak." A number or a failing input turns a vague worry into an actionable finding the reader can judge at their scale.

**Group by cause, not by file.** Ten sites of the same missing null-guard are ONE finding, not ten — consolidate and cite every site in the evidence.

**A finding you can't ground is a question, not an assertion.** If you can't cite the failing path, emit it `uncertain:true` at your real confidence — the verifier adjudicates. Don't assert to look thorough.
