#!/bin/bash
# specrails doctor — health check for specrails-core installations
# Usage: specrails doctor
# Exit 0 if all checks pass, 1 if any check fails.

set -uo pipefail

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
BOLD='\033[1m'

PASS=0
FAIL=0
RESULTS=()

pass() { RESULTS+=("$(printf "${GREEN}✅${NC} $1")"); PASS=$((PASS + 1)); }
fail() { RESULTS+=("$(printf "${RED}❌${NC} $1\n   Fix: $2")"); FAIL=$((FAIL + 1)); }

echo ""
echo -e "${BOLD}specrails doctor${NC}"
echo ""

# Determine project root (current working directory)
PROJECT_ROOT="${PWD}"

# ─────────────────────────────────────────────
# Check 1: Claude Code CLI
# ─────────────────────────────────────────────
if CLAUDE_PATH=$(command -v claude 2>/dev/null); then
    pass "Claude Code CLI: found (${CLAUDE_PATH})"
else
    fail "Claude Code CLI: not found" "Install Claude Code: https://claude.ai/download"
fi

# ─────────────────────────────────────────────
# Check 2: Claude API key
# ─────────────────────────────────────────────
if command -v claude &>/dev/null; then
    if claude config list 2>/dev/null | grep -q "api_key" || [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        pass "API key: configured"
    else
        fail "API key: not configured" "Run: claude config set api_key <your-key>  |  Get a key: https://console.anthropic.com/"
    fi
fi

# ─────────────────────────────────────────────
# Check 3: Agent files present
# ─────────────────────────────────────────────
AGENTS_DIR="${PROJECT_ROOT}/agents"
if [[ -d "${AGENTS_DIR}" ]]; then
    AGENT_COUNT=$(find "${AGENTS_DIR}" -name "AGENTS.md" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${AGENT_COUNT}" -ge 1 ]]; then
        AGENT_NAMES=$(find "${AGENTS_DIR}" -name "AGENTS.md" -exec dirname {} \; | xargs -I{} basename {} | tr '\n' ', ' | sed 's/,$//')
        pass "Agent files: ${AGENT_COUNT} agent(s) found (${AGENT_NAMES})"
    else
        fail "Agent files: agents/ exists but no AGENTS.md found" "Run specrails-core init to set up agents"
    fi
else
    fail "Agent files: agents/ directory not found" "Run specrails-core init to set up agents"
fi

# ─────────────────────────────────────────────
# Check 4: CLAUDE.md present
# ─────────────────────────────────────────────
if [[ -f "${PROJECT_ROOT}/CLAUDE.md" ]]; then
    pass "CLAUDE.md: present"
else
    fail "CLAUDE.md: missing" "Run /setup inside Claude Code to regenerate"
fi

# ─────────────────────────────────────────────
# Check 5: Git initialized
# ─────────────────────────────────────────────
if [[ -d "${PROJECT_ROOT}/.git" ]]; then
    pass "Git: initialized"
else
    fail "Git: not a git repository" "Initialize with: git init"
fi

# ─────────────────────────────────────────────
# Check 6: npm present
# ─────────────────────────────────────────────
if NPM_VERSION=$(npm --version 2>/dev/null); then
    pass "npm: found (v${NPM_VERSION})"
else
    fail "npm: not found" "Install npm: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm"
fi

# ─────────────────────────────────────────────
# Output results
# ─────────────────────────────────────────────
for line in "${RESULTS[@]}"; do
    echo -e "${line}"
done

echo ""

if [[ "${FAIL}" -eq 0 ]]; then
    TOTAL=$((PASS + FAIL))
    echo -e "All ${TOTAL} checks passed. Run ${BOLD}/sr:product-backlog${NC} to get started."
else
    echo "${FAIL} check(s) failed."
fi

# ─────────────────────────────────────────────
# Append to ~/.specrails/doctor.log
# ─────────────────────────────────────────────
LOG_DIR="${HOME}/.specrails"
mkdir -p "${LOG_DIR}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u)
TOTAL=$((PASS + FAIL))
echo "${TIMESTAMP}  checks=${TOTAL} passed=${PASS} failed=${FAIL}" >> "${LOG_DIR}/doctor.log"

echo ""

exit $([[ "${FAIL}" -eq 0 ]] && echo 0 || echo 1)
