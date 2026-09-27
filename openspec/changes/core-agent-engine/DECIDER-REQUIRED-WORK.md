# Required work before decision completion

27 September 2026. Legacy loops retain passFailed across a pass and still invoke
the decider before refusing a premature stop. A conversion that routes Core's
stop through a later condition would erase the decider's no-progress observation:
the piece had already recorded stop and reset its consecutive continue count.

Catalog version 4 adds optional continueWhen, using the existing bounded state
expression grammar. Evaluate it without additional inference; preserve the real
provider call and convert a valid stop proposal to continue before no-progress
accounting. Output identifies the proposed verdict and required continuation.
The graph owns clearing the underlying obligation after recovery; the decider
cannot erase it. The guard does not authorize success or replace host verification.

Publication validates the expression. A blocked human decision remains a durable
question and follows the established continuation without an extra call, without
advancing its no-progress history. Omission preserves existing behavior. Retained
packages keep their frozen catalog. This is a conversion prerequisite, not a
claim that all saved legacy graphs have been migrated.
