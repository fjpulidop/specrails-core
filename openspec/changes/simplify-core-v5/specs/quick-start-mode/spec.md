# Delta Spec: quick-start-mode

## REMOVED Requirements

### Requirement: Quick start mode as a distinct install tier
**Reason**: The quick/full tier distinction is removed in v5. Quick-tier direct placement is promoted to the ONLY installation behavior (see the new `modeless-install` capability), so a spec describing it as a *mode* — with mode detection, an "Advanced Mode" counterpart, a `--quick` flag, `CLAUDE-quickstart.md` tier-specific template handling, and a tier behavior matrix — no longer describes anything real.
**Migration**: The behavioral content (direct placement of core agents, commands, rules, skills) is superseded by `modeless-install`. The legacy prose spec file `openspec/specs/quick-start-mode.md` is deleted at archive time.
