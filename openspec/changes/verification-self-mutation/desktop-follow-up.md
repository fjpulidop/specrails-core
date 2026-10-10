# Desktop follow-up: verification self-mutation

Core change `verification-self-mutation` adds only optional fields and one new code. Older Desktop builds keep working: they still see `valid`, `outcome` and the error code. To explain these runs, Desktop should render the new fields.

## New Core surface

- **Receipt `selfMutation`** (the `VerificationReceipt` in receipt evidence, the engine `verify` output and the legacy `VerificationRecord`):
  - Shape: `{ files: [{ repositoryId, path, change: 'added' | 'modified' | 'removed' }], omittedFiles?, commands: [{ repositoryId, label }] }`.
  - At most 200 files are listed; `omittedFiles` counts the rest.
  - The receipt `reason` now reads `Verification commands modified N candidate file(s): …`, not `Candidate changed during verification`.
- **`adoptedOutputs`** (engine `verify` output; legacy `VerificationRecord`):
  - Shape: `[{ repositoryId, path, change }]`.
  - It lists the files the host kept in the candidate after a stable re-run. They stay listed for the rest of the run.
- **Blocker** `{ kind: 'nondeterministic-output', reason, command, args, cwd, requiredAction }` with error code `verification_nondeterministic_output`:
  - Engine `verify`: outcome `blocked` when `hostBlockers: true`, otherwise `failed`.
  - Legacy graph (Implement): status `blocked`. The error text includes `(verification_nondeterministic_output)`. It reaches Desktop as `implementation_blocked`.
- **Progress lines** on `verification-output`:
  - `[verification] Verification commands modified … ; keeping them in the candidate and verifying once more.`
  - `[verification] adopted N generated file(s): …`
- **Guardrail `verification-output-adoption`**:
  - Host phase, on by default.
  - Listed in `runtime api` → `guardrails` and in `schemas/agent-runtime.schema.json`.

## Desktop work

1. **Job Detail.** Show `selfMutation.files`, grouped by repository with their change kind, plus the commands that ran. Show `adoptedOutputs` as "Adopted verification output". Render the `nondeterministic-output` blocker with its `requiredAction`, in the same way as the other host blockers.
2. **PR-decision `statusDetail`.** Name the adopted files, so the reviewer knows they come from the repository's own tooling. For a `verification_nondeterministic_output` stop, explain that the generated output must be committed on the base branch or the generator made idempotent. Do not report a generic `implementation_failed`.
3. **Guardrail settings.** Add a label and a description for `verification-output-adoption` in all 8 locales. Suggested English:
   - Label: "Adopt verification output".
   - Description: "When the project's own verification commands regenerate files (for example a lint step rewriting a mapping), keep them in the change and verify once more instead of reverting them. Off: stop the run and name the files."
4. **Vendored schema.** Re-vendor `schemas/agent-runtime.schema.json`, which adds the new guardrail key, on the next Core pin.
