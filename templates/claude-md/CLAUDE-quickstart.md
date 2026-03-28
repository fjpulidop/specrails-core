# {{PROJECT_NAME}}

> {{PROJECT_DESCRIPTION}}

**Target users:** {{TARGET_USERS}}

---

## Agent Team

This project uses the specrails agent workflow. The following agents are active:

- **CEO** — product direction and goal-setting
- **CTO** — architecture decisions and technical standards
- **Tech Lead** — implementation coordination
- **Founding Engineer** — full-stack development

Git access level: **{{GIT_ACCESS}}**

---

## Working with the Agent Team

Start with a product backlog to discover what to build first:

```
/specrails:product-backlog
```

Then implement features using the full pipeline:

```
/specrails:implement #1 #2 #3
```

---

## Health Check

If something seems off, run:

```
specrails doctor
```

Or inside Claude Code:

```
/specrails:doctor
```

---

## Engineering Standards

- Write specs before code (OpenSpec for behavioral specs)
- Conventional commits on all git commits
- All PRs require review before merge
