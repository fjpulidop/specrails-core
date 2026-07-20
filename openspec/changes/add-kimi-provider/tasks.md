## 1. Provider contract and prerequisites

- [x] 1.1 Add Kimi to the canonical provider types, install config, CLI flags, TUI choices, help text, and validation errors
- [x] 1.2 Detect native/npm Kimi executables cross-platform and preserve the existing automatic provider priority
- [x] 1.3 Add bounded Kimi version and authentication probes with official install and `kimi login` remediation
- [x] 1.4 Extend prerequisite, init, and doctor tests for missing, explicit, authenticated, and multi-provider Kimi scenarios

## 2. Kimi framework rendering

- [x] 2.1 Define explicit Kimi paths, linked/static subtrees, mutable state, gitignore, manifest, and reserved-path behavior
- [x] 2.2 Render `.kimi-code/AGENTS.md` and provider settings without writing or overwriting the root Codex `AGENTS.md`
- [x] 2.3 Render every applicable SpecRails command as a valid directory-form Kimi skill
- [x] 2.4 Render selected baseline and optional/custom agents as direct-child Kimi rail-role skills
- [x] 2.5 Translate Claude/OpenSpec nested calls to Kimi's built-in `Skill`
  tool with explicit `skill`/`args`, and translate provider paths/tool
  terminology without relying on interactive slash text
- [x] 2.6 Add Kimi-specific inventory and forbidden-syntax snapshot tests for full and quick tiers

## 3. OpenSpec and profiles

- [x] 3.1 Normalize generated legacy `.kimi/skills/openspec-*` output into `.kimi-code/skills` atomically
- [x] 3.2 Preserve corrected upstream `.kimi-code` output and user-owned Kimi files during init and update
- [x] 3.3 Ensure the complete required OpenSpec workflow skill set is installed and verified for Kimi
- [x] 3.4 Extend profile/model contracts so Kimi identifiers are retained without silently mapping Claude aliases
- [x] 3.5 Preserve and validate `custom-*` Kimi role skills and profile references across updates

## 4. Lifecycle parity

- [x] 4.1 Add Kimi to standalone scaffold, versioned framework materialization, current-link assembly, and relocated workspaces
- [x] 4.2 Add Kimi to update, migration, cleanup, rollback, and stale-provider pruning safeguards
- [x] 4.3 Add Kimi to multi-provider registry/manifest behavior without altering other provider trees
- [x] 4.4 Add provider-specific doctor checks for Kimi framework, OpenSpec placement, roles, and stale `.kimi`
- [x] 4.5 Repair same-version nested Kimi frameworks and safely migrate
  pre-release `skills/rails` custom roles without destructive collision handling
- [x] 4.6 Materialize, relocate, update, manifest, and diagnose the complete
  `.kimi-code/specrails/` runner, vendored YAML parser, license, and provenance
  bundle

## 5. Headless execution contract

- [x] 5.1 Define and test the canonical managed-helper-to-external-`kimi -p
  --output-format stream-json` new-session argument contract
- [x] 5.2 Define and test known-session resume, model, effort, attachment-path, and skill invocation arguments
- [x] 5.3 Document CLI-only cancellation, session-hint, telemetry, image, and no-server ownership semantics
- [x] 5.4 Reproduce Kimi 0.27 full YAML skill parsing, parameter expansion, XML
  wrapper, and session/skill-directory placeholders in a self-contained Node
  helper with vendored `js-yaml`
- [x] 5.5 Launch external Kimi without a shell, validate spawn-boundary model
  ids, normalize only official ids, and safely unwrap the standard npm Windows
  `.cmd` shim
- [x] 5.6 Execute every single/parallel role group through one validated
  role-wave request; provide unique current-role execution directories,
  reusable git worktrees with starting overlays and atomic base/path manifests,
  attributed output, aggregate failure, and all-child signal forwarding
- [x] 5.7 Treat persisted role manifests and copied provider overlays as
  untrusted: recompute exact managed paths and private-ref identity before
  stateful operations, and verify a complete deterministic content hash before
  reusing a copied overlay

## 6. Documentation and verification

- [x] 6.1 Update README, integration contract, supported-provider documentation, examples, and upgrade guidance
- [x] 6.2 Run formatting, typecheck, unit, installer integration, template inventory, relocation, and package tests
- [x] 6.3 Verify the OpenSpec change against implementation and record any live-Kimi canary limitation
- [x] 6.4 Replace false headless `/skill:` examples/contracts, use the native
  nested `Skill` tool, and add YAML, security, Unicode, multiline, lifecycle,
  migration, multi-provider doctor, stable-engine/model-effort environment
  scrubbing, cron/auto-update child isolation, large-prompt stdin transport,
  native command-line budgets, and Windows-shim coverage
- [x] 6.5 Validate attachment canonicalization and safe directory grants,
  terminal-success-only resume hints, activation-time runtime context,
  symlink-safe atomic OpenSpec normalization, manifest tampering, private-ref
  retargeting, and copied-overlay corruption recovery

## Verification evidence

- Final `npm test`: 34 test files and 499 tests passed, including the TypeScript
  compile gate. Focused post-hardening suites also pass: Kimi runtime/runner
  86/86, scaffold 42/42, Kimi OpenSpec/invocation 13/13,
  framework/registry 62/62, profile/init 25/25, and doctor 18/18.
- `npm run typecheck`, `npm run build`, `git diff --check`, JSON parsing, CLI syntax checks, and
  `npm --cache /private/tmp/specrails-kimi-npm-cache pack --dry-run` passed.
- `openspec validate add-kimi-provider --strict --no-interactive` passed.
- Kimi inventory tests verify every generated direct child has `SKILL.md`,
  nested workflows use Kimi's native `Skill` tool, external roles use one
  bounded role-wave request plus a static foreground helper command, no
  `skills/rails` or `skills/personas` directory is generated, and persona
  references resolve to `.kimi-code/personas/`.
- Runner tests cover full YAML, exact placeholder/XML behavior, Unicode and
  multiline input, session/model grammars, shell-injection payloads, stable
  engine/cron/auto-update environment isolation, signal and stdin failures,
  upstream-compatible realpaths for relocated symlinks, npm shim precedence,
  current-repo execution isolation, dirty/untracked worktree snapshots,
  worktree reuse/manifests, manifest-path tampering and private-ref retargeting,
  full copied-overlay content hashes and corruption recovery, attributed
  parallel output, aggregate partial failure and cancellation, exact plain
  prompt stdin transport, and native Windows command-line failure before
  truncation.
- OpenSpec normalization tests reject symlinked roots, skills, and nested
  entries, preserve colliding user-owned predictable names, and verify atomic
  same-filesystem staging and rollback. Attachment tests reject missing,
  unreadable, directory, and symlink inputs while canonicalizing each accepted
  file and granting only its unique parent directory.
- End-to-end manual smoke passed on both Node 25.9.0 and the supported floor
  Node 20.19.5: TUI config + Kimi init, 19 workflow inventory, profile
  validation, 14-check doctor, headless enrich through a fake external
  Kimi 0.27 executable, byte-exact Unicode/multiline plain-prompt transport,
  user skill/MCP preservation on update, and relocated Claude+Kimi registry and
  manifest coexistence.
- A live authenticated Kimi canary was not run in this environment; the
  daemon-free CLI, helper, generated inventories, and stream fixtures are
  validated against Kimi Code 0.27 source/documentation. On Windows the
  standard npm shim is required for complete workflows above the native
  `CreateProcess` argv budget; native executables remain supported for bounded
  prompts.
