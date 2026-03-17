---
id: feature-proposal-modal
title: Feature Proposal Modal
status: designing
created: 2026-03-17
repos:
  - specrails
  - specrails-manager
---

# Feature Proposal Modal

## Problem

Non-technical stakeholders and product owners have no self-service way to surface feature ideas into the GitHub backlog. Currently, proposing a feature requires access to GitHub and knowledge of how to write a well-structured Issue. This creates a bottleneck where engineering or product managers must manually transcribe ideas, often losing context, specificity, and business rationale in the translation.

The web-manager dashboard is already the primary interface for orchestrating AI-driven development. It is the right place to close this loop — giving anyone with dashboard access the ability to propose features that feed directly into the development pipeline.

## Solution

Add a "Propose Feature" entry point to the Dashboard that opens a full-screen modal. Inside the modal, the user describes their idea in plain language. Claude — invoked via a new `/sr:propose-feature` command — explores the idea against the actual codebase and produces a structured proposal: title, problem statement, solution approach, out-of-scope items, and acceptance criteria. The output streams back to the modal in real time.

The user can then refine the proposal through a conversational loop (Claude is resumed via `--resume <session_id>`) until they are satisfied. A single "Create Issue" button materialises the proposal as a GitHub Issue with the label `user-proposed`, completing the feedback loop from idea to backlog.

## User Story

As a non-technical product owner, I want to describe a feature idea in plain English from the web-manager dashboard, collaborate with Claude to refine it into a structured proposal, and create a GitHub Issue with one click — without ever touching GitHub directly.

## Non-Goals

- This feature does not implement the feature it proposes. Issue creation is the terminal action; /sr:implement must be run separately.
- No JIRA support in this version. GitHub Issues only.
- No proposal approval workflow or multi-reviewer step.
- No proposal history view beyond what's visible in the modal session (full history lives in SQLite).
- No email or notification system for created issues.

## Success Criteria

- Non-technical user can open modal, describe idea, see streaming structured analysis, refine via chat, create GitHub Issue — all without leaving the dashboard.
- Claude reads the target project's codebase to ground proposals in reality.
- Proposals are persisted per-project in SQLite and survive server restarts.
- The refinement loop is stateless from the frontend's perspective (session_id is managed by the server).
- Cancel at any step leaves no orphaned processes or dangling DB records (status transitions are clean).
- Created issues always carry the `user-proposed` label and the structured markdown body.

## Motivation

The specrails product vision is a fully autonomous development loop: idea → issue → implement → review → ship. The proposal modal closes the first gap — bridging the human idea to the structured backlog item that the rest of the pipeline consumes.
