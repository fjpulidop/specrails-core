---
change: security-reviewer-agent
type: feature
status: proposed
github_issue: 4
vpc_fit: 80%
---

# Proposal: Security & Secrets Reviewer Agent

## Problem

AI-generated code can silently introduce secrets and security vulnerabilities that are invisible during normal code review:

- **Secrets leak**: LLMs occasionally generate plausible-looking API keys, tokens, or database connection strings while filling in example code. Without automated scanning, these reach version control.
- **OWASP vulnerabilities**: AI-generated code reproduces known vulnerable patterns (SQL injection, XSS, insecure authentication) because the patterns exist in training data.
- **No safety net in the current pipeline**: Phase 4 (Merge & Review) runs a quality-gate reviewer but it has no security mandate — it checks CI conformance, not threat surface.

This is classified as blocking production use. The specrails implement pipeline is designed to accelerate AI-driven development; shipping that pipeline without a security gate creates a liability for every team that adopts it.

## Solution

Add a `security-reviewer` agent that runs automatically at the end of Phase 4, after the existing `reviewer` agent completes. The agent:

1. Scans every modified file for secrets using regex patterns and Shannon entropy analysis.
2. Checks for OWASP Top 10 vulnerability patterns via Claude's own code analysis (no external binary dependency required at launch).
3. Reports findings organized by severity: Critical / High / Medium / Info.
4. **Blocks the pipeline** if any Critical findings exist (hardcoded secrets, live credentials).
5. Surfaces High and Medium findings as warnings that must be acknowledged before shipping.
6. Supports per-project exemption config so teams can whitelist known false positives.

## Scope

**In scope:**
- New agent: `templates/agents/security-reviewer.md` (template) and `.claude/agents/security-reviewer.md` (generated)
- Integration into Phase 4b of the implement pipeline (both template and generated versions)
- Exemption config format: `.claude/security-exemptions.yaml`
- Exemption config template: `templates/security/security-exemptions.yaml`
- Severity severity-based merge blocking logic in the implement command
- Agent memory system (same pattern as reviewer)

**Out of scope:**
- External tool integration (truffleHog, semgrep, npm audit) — Phase 2 enhancement
- CI pipeline integration (no CI exists yet)
- IDE plugin or pre-commit hooks
- SBOM generation or dependency vulnerability scanning beyond npm audit patterns

## Non-goals

- This agent does NOT replace human security review for high-risk changes.
- This agent does NOT fix security issues autonomously (unlike the reviewer). It reports and blocks; the developer fixes.
- This agent does NOT run on every file in the repo — only files modified in the current implementation run.

## Motivation

VPC fit score: 80%. This is the highest-scoring unimplemented feature. Lead developers adopting specrails identified "secrets accidentally shipped by AI agents" as the primary blocker to trusting the pipeline in production environments.
