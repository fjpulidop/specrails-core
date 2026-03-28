# MCP Server for specrails-core — Feasibility Analysis

**Date:** 2026-03-21
**Author:** CTO of Engineering
**Status:** Research Complete — Recommendation Included
**Task:** SPEA-480

---

## Executive Summary

This document evaluates whether building an MCP (Model Context Protocol) server for specrails-core is strategically sound. After thorough analysis of the current architecture, the MCP protocol capabilities, and the product roadmap, **the recommendation is YES — with a focused, phased scope**.

An MCP server should expose **read-only knowledge access** and **lightweight utility operations**, while the multi-agent orchestration pipeline stays in Claude Code commands. This approach maximizes cross-client reach with minimal maintenance overhead.

---

## 1. What is MCP?

The **Model Context Protocol** is Anthropic's open standard for connecting AI models to external data sources and tools. It defines three primitives:

| Primitive | Purpose | Direction |
|-----------|---------|-----------|
| **Resources** | Expose read-only data (files, records, configs) | Server → Client |
| **Tools** | Actions that modify state or compute results | Client → Server → Client |
| **Prompts** | Parameterized prompt templates | Server → Client |

MCP servers run as local processes (stdio) or remote services (HTTP+SSE). Any MCP-compatible client can connect: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code (Copilot), Zed, and others.

---

## 2. Current specrails-core Architecture (No MCP)

### Distribution & Execution Model

```
npx specrails-core@latest init    →   install.sh (bash)    →   /setup (Claude Code command)
                                        │                         │
                                        ├── Copy templates        ├── Detect codebase
                                        ├── Create dirs           ├── Generate agents
                                        └── Write manifest        └── Substitute placeholders
```

### Runtime Architecture

```
Claude Code
├── Commands (/specrails:implement, /specrails:product-backlog, ...)
├── Skills (/opsx:new, /opsx:apply, /opsx:ff, ...)
├── Agents (sr-architect, sr-developer, sr-reviewer, ...)
├── Rules (.claude/rules/ — layer-specific conventions)
└── Agent Memory (.claude/agent-memory/ — explanations, failures)
```

### Key Characteristics

- **Zero-daemon**: No running processes — everything is files + CLI commands
- **Claude Code-native**: Tight integration with Agent tool, worktrees, Skills API
- **CLI-based integrations**: GitHub CLI, OpenSpec CLI, npm — no HTTP APIs
- **Local-first**: All state stored on filesystem (JSON, YAML, Markdown)
- **12 specialized agents** with orchestrated multi-phase pipeline
- **80+ template placeholders** for codebase-adaptive generation

---

## 3. What Would an MCP Server Expose?

### 3.1 Resources (Read-Only Data)

| Resource | URI Pattern | Description |
|----------|-------------|-------------|
| Specs | `specrails://specs/{name}` | OpenSpec specifications (source of truth) |
| Active Changes | `specrails://changes/{name}` | Active OpenSpec changes with status |
| Archived Changes | `specrails://changes/archive/{name}` | Historical change records |
| Personas | `specrails://personas/{name}` | VPC persona profiles (jobs, pains, gains) |
| Agent Config | `specrails://agents/{name}` | Agent personality & configuration |
| Layer Rules | `specrails://rules/{layer}` | Per-layer coding conventions |
| Failure Records | `specrails://memory/failures` | CI failure patterns and prevention rules |
| Explanations | `specrails://memory/explanations` | Implementation decision records |
| Project Config | `specrails://config` | CLAUDE.md, integration contract, manifest |

### 3.2 Tools (Actions)

| Tool | Input | Output | Side Effects |
|------|-------|--------|--------------|
| `specrails_doctor` | (none) | Health check report | None (read-only) |
| `specrails_score_feature` | Feature description | VPC scores per persona | None |
| `specrails_analyze_codebase` | Project root path | Stack, architecture, conventions | None |
| `specrails_list_changes` | (optional filters) | Active changes with status | None |
| `specrails_get_change_status` | Change name | Artifact status, task progress | None |
| `specrails_query_failures` | File glob pattern | Matching failure records | None |
| `specrails_query_backlog` | (optional filters) | GitHub Issues with VPC scores | None |
| `specrails_check_compat` | Version string | Integration contract validation | None |

### 3.3 Prompts (Templates)

| Prompt | Parameters | Purpose |
|--------|------------|---------|
| `review_with_conventions` | `layer`, `files` | Review prompt with auto-loaded layer rules |
| `explore_feature` | `description` | VPC-aware feature exploration prompt |
| `implement_context` | `change_name` | Context bundle for a specific change |

---

## 4. Strategic Analysis

### 4.1 Arguments FOR an MCP Server

#### A. Cross-Client Reach (High Impact)

Currently specrails-core **only works inside Claude Code**. An MCP server makes the knowledge layer accessible from:

- **Claude Desktop** — Product managers can query personas and backlog without a terminal
- **Cursor / Windsurf** — Developers in other IDEs get specrails context
- **VS Code (Copilot)** — Teams using GitHub Copilot can still access specs and conventions
- **Custom tooling** — Any MCP client can connect

This dramatically expands the addressable market beyond Claude Code-only users.

#### B. Tool Ecosystem Composability (Medium Impact)

MCP is becoming the standard protocol for AI tool integration. As an MCP server, specrails-core can be **composed** with:

- Database MCP servers (query production data alongside specs)
- Monitoring MCP servers (correlate failures with system metrics)
- CI/CD MCP servers (trigger builds with specrails context)

#### C. Structured API for Hub Integration (High Impact)

specrails-hub currently uses a rigid `integration-contract.json` for core↔hub communication. An MCP server provides a **dynamic, structured API** that hub can query:

```
Current:  Hub reads static JSON contract → spawns CLI commands
With MCP: Hub connects as MCP client → queries resources, invokes tools
```

This eliminates the version-coupling problem where hub must know core's CLI interface.

#### D. Separation of Concerns (Medium Impact)

The current architecture tightly couples specrails to Claude Code's command/skill system. MCP creates a clean **knowledge API layer** separate from the **orchestration layer**:

```
┌─────────────────────────────────────────────┐
│              MCP Server (Knowledge)          │
│  Specs, Personas, Memory, Config, Analysis   │
├─────────────────────────────────────────────┤
│         Claude Code (Orchestration)          │
│  /specrails:implement, /specrails:batch-implement, agents  │
└─────────────────────────────────────────────┘
```

#### E. Remote/Multi-Repo Scenarios (Future Value)

MCP supports HTTP+SSE transport. A centralized specrails MCP server could:

- Serve specs across multiple repos from one instance
- Enable cross-repo knowledge queries
- Power a team-wide development dashboard

### 4.2 Arguments AGAINST an MCP Server

#### A. Current System Works Well

Skills and commands already provide strong Claude Code integration. MCP adds complexity for users who only use Claude Code.

**Counter:** MCP doesn't replace commands/skills — it supplements them with cross-client access.

#### B. Orchestration Can't Move to MCP

The `/specrails:implement` pipeline requires Claude Code's Agent tool (subagent spawning, worktree isolation, background execution). MCP tools are request/response — they can't replicate multi-phase orchestration.

**Counter:** This is exactly why the recommendation is scoped. Orchestration stays in Claude Code; only knowledge access moves to MCP.

#### C. Maintenance Overhead

Two interfaces to maintain (skills + MCP). Template changes could require updates in both.

**Counter:** MCP resources are read-only wrappers around existing files. No template duplication — the MCP server reads the same files that skills read.

#### D. MCP Server Process Overhead

Currently specrails-core is zero-daemon. Adding an MCP server means a running process.

**Counter:** MCP stdio servers start on-demand (launched by the client). No persistent daemon needed. The MCP server binary can ship with the npm package.

#### E. Protocol Maturity

MCP is still evolving. Breaking changes in the protocol could require updates.

**Counter:** MCP has reached stable specification status. Core primitives (resources, tools, prompts) are unlikely to change fundamentally.

---

## 5. Competitive Landscape

| Product | MCP Support | Notes |
|---------|-------------|-------|
| **Cursor** | MCP client | Users can connect to any MCP server |
| **Windsurf** | MCP client | Growing MCP ecosystem |
| **Continue.dev** | MCP client | Open-source IDE extension |
| **Cline** | MCP client | VS Code extension with MCP |
| **aider** | No MCP | CLI-only, no extensibility protocol |
| **Devin** | No MCP | Closed platform |
| **specrails-core** | **No MCP (current)** | Claude Code-only |

Having MCP support positions specrails-core as the **only product-driven development framework accessible from any MCP client**.

---

## 6. Recommended Architecture

### 6.1 Server Design

```
specrails-core/
├── src/
│   └── mcp/
│       ├── server.ts              # MCP server entry point
│       ├── resources/
│       │   ├── specs.ts           # OpenSpec spec resources
│       │   ├── changes.ts         # Change status resources
│       │   ├── personas.ts        # VPC persona resources
│       │   ├── agents.ts          # Agent config resources
│       │   ├── memory.ts          # Memory/failure resources
│       │   └── config.ts          # Project config resources
│       ├── tools/
│       │   ├── doctor.ts          # Health check tool
│       │   ├── score-feature.ts   # VPC scoring tool
│       │   ├── analyze.ts         # Codebase analysis tool
│       │   ├── query-backlog.ts   # Backlog query tool
│       │   └── change-status.ts   # Change status tool
│       └── prompts/
│           ├── review.ts          # Review with conventions
│           └── explore.ts         # VPC-aware exploration
├── bin/
│   └── specrails-mcp.js           # MCP stdio entry point
└── package.json                   # Add "specrails-mcp" bin entry
```

### 6.2 Transport & Distribution

```json
// Client configuration (e.g., claude_desktop_config.json)
{
  "mcpServers": {
    "specrails": {
      "command": "npx",
      "args": ["specrails-core@latest", "mcp"],
      "env": {
        "SPECRAILS_PROJECT_ROOT": "/path/to/project"
      }
    }
  }
}
```

- **Transport**: stdio (launched by client on-demand)
- **Distribution**: Ships with existing npm package — no separate install
- **CLI entry**: `specrails-core mcp` starts the MCP server
- **Project detection**: Uses `SPECRAILS_PROJECT_ROOT` env var or auto-detects from cwd

### 6.3 Technology Choice

| Option | Pros | Cons |
|--------|------|------|
| **TypeScript (recommended)** | Same language as rest of specrails ecosystem, official `@modelcontextprotocol/sdk` package, type safety | Build step required |
| Python | Official SDK, large MCP community | Different language from rest of stack |
| Bash | Consistent with install.sh | No MCP SDK, painful to implement |

**Recommendation: TypeScript** using `@modelcontextprotocol/sdk`.

---

## 7. Implementation Phases

### Phase 1 — Core Resources (MVP)

**Effort:** ~2-3 days
**Value:** Immediate cross-client access to specrails knowledge

| Deliverable | Description |
|-------------|-------------|
| MCP server scaffold | TypeScript server with stdio transport |
| Spec resources | Read OpenSpec specs by name |
| Change resources | List active changes, get status |
| Persona resources | Read VPC personas |
| Config resource | Read project CLAUDE.md and layer rules |
| `specrails-core mcp` CLI | Start MCP server from existing npm package |

### Phase 2 — Tools & Memory

**Effort:** ~2-3 days
**Value:** Actionable intelligence from any MCP client

| Deliverable | Description |
|-------------|-------------|
| `specrails_doctor` | Health check tool |
| `specrails_score_feature` | VPC scoring tool |
| `specrails_query_failures` | Failure pattern queries |
| `specrails_query_memory` | Agent memory search |
| `specrails_list_changes` | Change listing with filters |

### Phase 3 — Hub Integration

**Effort:** ~3-5 days
**Value:** Replace rigid integration contract with dynamic MCP API

| Deliverable | Description |
|-------------|-------------|
| Hub MCP client | specrails-hub connects as MCP client |
| Dynamic command discovery | Hub queries available commands via MCP |
| Real-time spec access | Hub reads specs through MCP resources |
| Status streaming | Change progress via MCP notifications |

### Phase 4 — Advanced Features

**Effort:** ~3-5 days
**Value:** Full ecosystem integration

| Deliverable | Description |
|-------------|-------------|
| `specrails_analyze_codebase` | Codebase analysis tool |
| `specrails_query_backlog` | VPC-scored backlog queries |
| Prompt templates | Review and explore prompts with context |
| Remote transport | HTTP+SSE for multi-repo scenarios |

---

## 8. What Stays in Claude Code (NOT in MCP)

These capabilities require Claude Code's runtime and should NOT be exposed via MCP:

| Capability | Reason |
|------------|--------|
| `/specrails:implement` pipeline | Requires Agent tool (subagent spawning) |
| `/specrails:batch-implement` | Requires git worktree isolation |
| Agent invocation (sr-*) | Requires Claude Code's Agent subagent system |
| OpenSpec artifact creation | Interactive, context-heavy (requires conversation) |
| `/setup` wizard | Multi-step interactive configuration |
| Template substitution (write) | Modifies project files, requires user consent |

**Principle:** MCP = knowledge access. Claude Code = orchestration engine.

---

## 9. Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MCP protocol breaking changes | Low | Medium | Pin SDK version, follow changelog |
| Maintenance burden (two interfaces) | Medium | Low | MCP reads same files as skills — no duplication |
| User confusion (MCP vs commands) | Medium | Low | Clear docs: "MCP for access, commands for action" |
| Security (exposing project data) | Low | Medium | Local stdio only (no remote by default), respect .gitignore |
| Scope creep (adding orchestration to MCP) | Medium | High | Strict scope boundary: no write operations in Phase 1-2 |

---

## 10. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Cross-client usage | 3+ MCP clients connect in first month | MCP server logs |
| Hub integration latency | 50% reduction vs CLI spawning | Hub performance metrics |
| Developer adoption | 20% of users configure MCP alongside commands | npm download analytics |
| Knowledge query volume | 100+ resource reads/day across users | MCP server telemetry |

---

## 11. Conclusion

Building an MCP server for specrails-core is **strategically sound** because:

1. **It opens a new distribution channel** — any MCP client becomes a specrails client
2. **It improves hub integration** — dynamic API replaces rigid contract
3. **It positions specrails uniquely** — only product-driven dev framework with MCP support
4. **It's low-risk** — read-only resources, no orchestration duplication, ships with existing package
5. **The effort is proportional** — Phase 1 MVP in 2-3 days, full implementation in ~2 weeks

The key insight is that specrails-core has two layers: **knowledge** (specs, personas, memory, config) and **orchestration** (agent pipeline, worktrees, CI). MCP is the perfect fit for the knowledge layer, while Claude Code commands remain the right tool for orchestration.

**Recommendation: Proceed with Phase 1 (Core Resources MVP).**
