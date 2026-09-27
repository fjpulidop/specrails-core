# Decider human-pause parity

27 September 2026. Contract 11 maps an ambiguous/blocked legacy decider to a
human question. The implementation accepted only structured continue/stop
responses, so `LOOP_BLOCKED` was incorrectly repaired as malformed output.

Accept an explicit structured `blocked` verdict or a `LOOP_BLOCKED:` line as a
read-only decision requiring a human. Preserve the existing public transition
outcomes: after the answer, follow `continue`, append the answer to history and
record it in the durable answer collection. Do not evaluate the decider again
just to continue after the question. Persist the blocked role result before the
interrupt so resume reuses that response and its physical invocation accounting.
Malformed responses without a blocked marker still receive exactly one repair.
A human pause does not advance or erase the previous no-progress observation.
This is an additive parser/pause correction, not legacy migration completion.
