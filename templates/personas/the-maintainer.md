# Persona: The Maintainer

> "I maintain this project in my spare time. Every hour I save on routine work is an hour I can spend on what actually matters."

## Profile

| Field | Value |
|-------|-------|
| **Name** | "Kai" — The Maintainer |
| **Age** | 25-45 |
| **Role** | Open-source maintainer, often solo or with 1-3 co-maintainers |
| **Projects** | 1-5 active repos, ranging from 100 to 50k+ stars |
| **Experience** | Deep expertise in their project's domain; variable breadth across stacks |
| **Tools today** | GitHub (Issues, PRs, Actions), Dependabot, CodeQL, Claude Code or Copilot |
| **Spending** | $0-20/month (OSS maintainers are cost-sensitive; many rely on free tiers/sponsorships) |
| **Tech comfort** | Very high — but time-poor; optimizes for efficiency above all |

## Behaviors

- Reviews 5-50 PRs per week, most from contributors they've never met
- Spends disproportionate time on triage — labeling issues, requesting info, closing duplicates
- Deeply skeptical of AI-generated PRs and "drive-by" contributions
- Values consistency and backwards compatibility over new features
- Writes detailed contributing guides but contributors rarely read them
- Burns out from the imbalance: contribution volume grows but maintainer capacity doesn't
- Will adopt automation that reduces their review burden without sacrificing quality

## Value Proposition Canvas

### Customer Jobs

| Type | Job |
|------|-----|
| Functional | Review and merge contributions efficiently without sacrificing quality |
| Functional | Maintain coding standards across a growing contributor base |
| Functional | Triage issues and PRs — separate signal from noise |
| Functional | Keep CI/CD green and catch regressions early |
| Functional | Keep dependencies up to date without introducing breaking changes |
| Functional | Coordinate releases — changelog curation, versioning, and publishing |
| Social | Build a healthy community where contributors feel welcomed and guided |
| Emotional | Avoid burnout from the growing volume of contributions and issues |
| Emotional | Feel that their project is sustainable, not just surviving |

### Pains

| Severity | Pain |
|----------|------|
| Critical | "Eternal September" — AI lowers contribution friction, flooding maintainers with low-quality PRs |
| Critical | Review burden scales with contributors but maintainer time doesn't |
| High | AI-generated contributions that look plausible but miss project conventions or architectural intent |
| High | No way to enforce project-specific coding standards automatically beyond basic linting |
| Medium | Automated scanning tools (security, code quality) generate noise — hard to distinguish real issues |
| Medium | Onboarding contributors to the project's specific patterns and conventions is time-consuming |
| Medium | Dependency upgrades require manual changelog review and breakage risk assessment — Dependabot creates noise without project-specific context |
| Medium | Release coordination is manual — changelog curation, version bumping, and publishing require synchronous maintainer attention |
| Medium | Feature requests pile up with no framework to evaluate which ones matter most to users |
| Low | Sponsorship/funding doesn't scale with project popularity or maintenance burden |

### Gains

| Impact | Gain |
|--------|------|
| High | Automated review that enforces project-specific conventions, not just generic lint rules |
| High | AI reviewer that knows the codebase deeply — catches architectural violations, not just style issues |
| High | Reduced time spent on routine reviews, freeing time for design decisions and community |
| Medium | Structured feature prioritization based on actual user needs (not loudest voices) |
| Medium | Implementation pipeline that lets maintainers describe features and get convention-compliant PRs |
| Medium | Institutional memory — the AI system remembers past decisions and enforces them consistently |
| Low | Easy setup that works with existing GitHub-based workflows (Issues, Actions, PRs) |
| Low | Free or very low cost for open-source projects |

## Key Insight

> Open-source maintainers are the most **time-constrained** users in the software ecosystem. They don't need more AI to *write* code — they need AI that *understands their project deeply enough* to review contributions, enforce conventions, and handle routine tasks so they can focus on architecture and community. The key unlock is project-specific intelligence, not generic coding ability.

## Feature Evaluation Criteria

When evaluating whether a feature is worth Kai's time and adoption risk:

| Criterion | Question |
|-----------|----------|
| **Review burden** | Does this reduce time spent reviewing contributions without adding maintainer overhead? |
| **Convention enforcement** | Does this enforce project-specific rules, not just generic coding standards? |
| **GitHub-native** | Does this work with Issues, PRs, and Actions — the tools Kai already lives in? |
| **Cost ceiling** | Is this free or under $20/month? (OSS projects cannot justify SaaS pricing) |
| **Contributor UX** | Does this improve contributor experience without adding new maintainer responsibilities? |
| **Backwards compatibility** | Does this respect the project's stability contract with existing users? |
| **Scale range** | Does this work for a 200-star hobby project and a 50k-star ecosystem library alike? |

A feature scores high for Kai (4-5/5) when it reduces async review work, enforces conventions automatically, or handles routine coordination (dependency updates, release notes) without requiring Kai to be online. A feature scores low (0-1/5) when it adds configuration burden, requires paid tiers, or is primarily useful for teams rather than solo/small maintainer groups.

## Sources

- [GitHub Blog — Welcome to the Eternal September of Open Source](https://github.blog/open-source/maintainers/welcome-to-the-eternal-september-of-open-source-heres-what-we-plan-to-do-for-maintainers/)
- [st0012.dev — AI and Open Source: A Maintainer's Take (End of 2025)](https://st0012.dev/2025/12/30/ai-and-open-source-a-maintainers-take-end-of-2025/)
- [The New Stack — Open Source: Inside 2025's 4 Biggest Trends](https://thenewstack.io/open-source-inside-2025s-4-biggest-trends/)
- [Anthropic — 2026 Agentic Coding Trends Report](https://resources.anthropic.com/hubfs/2026%20Agentic%20Coding%20Trends%20Report.pdf)
- [Augment Code — 6 Best Devin Alternatives for AI Agent Orchestration](https://www.augmentcode.com/tools/best-devin-alternatives)
