# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest 6.x minor (npm `latest`, currently 6.6.x) | ✅ |
| Version on the npm `stable` dist-tag | ✅ |
| Older releases, including 5.x | ❌ |

Security fixes are released as a patch of the latest 6.x minor. When the version on `stable` is affected, the fix is promoted to `stable` (see the [release policy](docs/release-policy.md)) or the advisory tells `stable` users which version to upgrade to. Please reproduce on one of the supported versions before reporting a vulnerability.

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

## Secrets in local state

The agent session journal (`~/.specrails/sessions/<scope>/sessions.sqlite`) is private to the current user and redacts recognisable secrets in tool input and output before it stores them. Redaction is best effort: it covers secret-like names, authorization headers, credential flags, URL passwords, common key formats and private key blocks, not every possible secret. Journals written before this protection are not rewritten. See [docs/agent-sessions/journal.md](docs/agent-sessions/journal.md#secret-redaction).

## Scope

This policy covers the `specrails-core` installer, the programmatic agent runtime and the templates it installs into user repositories. It does not cover vulnerabilities in third-party tools the runtime invokes (e.g., Claude Code, Codex, Gemini CLI, Kimi Code).
