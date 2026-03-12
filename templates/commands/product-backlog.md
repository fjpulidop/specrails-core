---
name: "Product Backlog"
description: "View product-driven backlog from GitHub Issues and propose top 3 for implementation"
category: Workflow
tags: [workflow, backlog, viewer, product-driven]
---

Display the product-driven backlog by reading issues/tickets from the configured backlog provider ({{BACKLOG_PROVIDER_NAME}}). These are feature ideas generated through VPC-based product discovery — evaluated against user personas. Use `/update-product-driven-backlog` to generate new ideas.

**Input:** $ARGUMENTS (optional: comma-separated areas to filter. If empty, show all.)

---

## Phase 0: Environment Pre-flight

Verify the backlog provider is accessible:

```bash
{{BACKLOG_PREFLIGHT}}
```

If the backlog provider is unavailable, stop and inform the user.

---

## Execution

Launch a **single** product-analyst agent (`subagent_type: product-analyst`) to read and prioritize the backlog.

The product-analyst receives this prompt:

> You are reading the product-driven backlog from {{BACKLOG_PROVIDER_NAME}} and producing a prioritized view.

1. **Fetch all open product-driven backlog items:**
   ```bash
   {{BACKLOG_FETCH_CMD}}
   ```

2. **Parse each issue/ticket** to extract metadata from the body:
   - **Area**: from `area:*` label
   - **Persona Fit**: from the body's Overview table — extract per-persona scores and total
   - **Effort**: from the body's Overview table (High/Medium/Low)
   - **Description**: from the body's "Feature Description" section
   - **User Story**: from the body's "User Story" section

3. **Group by area**.

4. **Sort within each area by Total Persona Score (descending)**, then by Effort (Low > Medium > High) as tiebreaker.

5. **Display** as a formatted table per area, then **propose the top 3 items** for implementation:

   ```
   ## Product-Driven Backlog

   {N} open issues | Source: VPC-based product discovery
   Personas: {{PERSONA_NAMES_WITH_ROLES}}

   ### {Area Name}

   | # | Issue | {{PERSONA_SCORE_HEADERS}} | Total | Effort |
   |---|-------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|
   | 1 | #42 Feature name | ... | X/{{MAX_SCORE}} | Low |

   ---

   ## Recommended Next Sprint (Top 3)

   Ranked by VPC persona score / effort ratio:

   | Priority | Issue | Area | {{PERSONA_SCORE_HEADERS}} | Total | Effort | Rationale |
   |----------|-------|------|{{PERSONA_SCORE_SEPARATORS}}|-------|--------|-----------|

   ### Selection criteria
   - Cross-persona features (both 4+/5) prioritized over single-persona
   - Low effort preferred over high effort at same score
   - Critical pain relief weighted higher than gain creation

   Run `/implement` to start implementing these items.
   ```

6. If no issues exist:
   ```
   No product-driven backlog issues found. Run `/update-product-driven-backlog` to generate feature ideas.
   ```
