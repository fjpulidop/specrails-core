# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest 5.x release | ✅ |
| Older releases | ❌ |

We only provide security fixes for the latest release. Please upgrade to the latest version before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's [private security advisory feature](https://github.com/fjpulidop/specrails-core/security/advisories/new) to report vulnerabilities confidentially.

Include in your report:
- A clear description of the vulnerability and its potential impact
- Steps to reproduce the issue
- The version of specrails-core affected
- Any relevant configuration or environment details
- Proof of concept or exploit code (if applicable)

## Response Timeline

| Step | SLA |
|------|-----|
| Initial acknowledgment | 48 hours |
| Triage and severity assessment | 7 days |
| Resolution timeline communicated | 14 days |
| Patch released (critical) | As soon as practicable |

## Responsible Disclosure Policy

We ask that you:
- Give us reasonable time to investigate and remediate before public disclosure
- Avoid accessing or modifying user data without permission
- Avoid disrupting production services during testing

In return, we commit to:
- Acknowledging your report promptly
- Keeping you informed of our progress
- Crediting you in the security advisory (unless you prefer anonymity)

## Security Updates

Security patches are released as patch versions as soon as practicable. We recommend always running the latest version of specrails-core.

Subscribe to [GitHub security advisories](https://github.com/fjpulidop/specrails-core/security/advisories) for this repository to receive notifications.

## Scope

This policy covers the `specrails-core` installer, the programmatic agent runtime and the templates it installs into user repositories. It does not cover vulnerabilities in third-party tools the runtime invokes (e.g., Claude Code, Codex, Gemini CLI, Kimi Code).
