# Proposal: Formalize OSS Maintainer Persona

## Problem

specrails ships with a high-quality Maintainer persona (`the-maintainer.md`) that captures the open-source maintainer's jobs, pains, and gains in detail. However, the `/setup` wizard treats this persona the same as any other — it only appears if the user describes "open-source maintainers" as their target users.

For OSS projects, the Maintainer is always a relevant persona. When a developer runs `/setup` in a public repo with CI and a CONTRIBUTING.md, they are almost certainly an open-source maintainer — or they have maintainers among their users. Not surfacing the Maintainer persona automatically means:

1. VPC feature scoring misses the Maintainer perspective on every feature evaluation
2. The product-manager agent may not include Kai's constraints when scoring trade-offs
3. Users who *are* OSS maintainers get no acknowledgement of their specific context

## Solution

Auto-detect OSS projects during `/setup` Phase 1 using three lightweight signals:

1. **Public repo**: `gh repo view --json isPrivate` returns `false`
2. **CI enabled**: `.github/workflows/` contains at least one `.yml` file
3. **CONTRIBUTING.md present**: file exists at repo root or `.github/CONTRIBUTING.md`

When all three signals are detected (or the user confirms they run an OSS project), automatically include the Maintainer persona in the setup output. The product-manager agent template already references the Maintainer persona file — this feature ensures it exists in the generated output.

## Scope

**In scope:**
- OSS detection logic in `install.sh` (detect signals, write a flag file)
- OSS detection in `/setup` Phase 1 (read signals, present to user for confirmation)
- Conditional persona inclusion in Phase 2 / Phase 4.2 (add `the-maintainer.md` when OSS flag is set)
- Update `commands/setup.md` to document the detection logic and conditional path
- Add a `{{MAINTAINER_PERSONA_LINE}}` placeholder to `templates/agents/product-manager.md` so generated product-manager agents always list the Maintainer when the persona is present

**Out of scope:**
- Changing the Maintainer persona content (it's already high quality)
- Supporting non-GitHub forges (GitLab, Bitbucket) — GitHub is the only supported backlog provider today
- Auto-detection with fewer than all three signals (partial signal = ask the user)

## Non-goals

- Do not change how other personas are generated
- Do not add a new "OSS mode" configuration toggle — the persona inclusion is the only behavioral change
- Do not modify CI detection logic beyond checking for `.github/workflows/*.yml` existence

## Product Motivation

OSS maintainers are the users with the **highest potential for word-of-mouth distribution**. They are also the persona with the most acute pains around contribution quality and review burden — the exact problems specrails solves. Getting the Maintainer perspective into VPC scoring automatically increases the relevance of every product discovery session for OSS projects.

This is a **Low effort** change: the persona already exists, the product-manager agent already references it. We're adding three detection signals and one conditional file-copy step.
