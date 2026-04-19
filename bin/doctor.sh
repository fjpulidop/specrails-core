#!/bin/bash
# specrails doctor — health check for specrails-core installations
# Usage: specrails doctor
# Exit 0 if all checks pass, 1 if any check fails.

set -uo pipefail

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

PROJECT_ROOT="${PWD}"

# ─────────────────────────────────────────────
# Provider detection
# ─────────────────────────────────────────────
PROVIDER="claude"
if [[ -f "${PROJECT_ROOT}/.specrails/install-config.yaml" ]]; then
    _detected=$(grep -E '^provider:' "${PROJECT_ROOT}/.specrails/install-config.yaml" 2>/dev/null | awk '{print $2}' | tr -d '"' | head -n1)
    [[ -n "$_detected" ]] && PROVIDER="$_detected"
elif [[ -d "${PROJECT_ROOT}/.codex" && ! -d "${PROJECT_ROOT}/.claude" ]]; then
    PROVIDER="codex"
fi

if [[ "$PROVIDER" == "codex" ]]; then
    SPECRAILS_DIR=".codex"
    INSTRUCTIONS_FILE="AGENTS.md"
    CLI_CMD="codex"
    CLI_NAME="Codex"
    CMD_PREFIX='$'
    CLI_INSTALL_URL="https://developers.openai.com/codex"
else
    SPECRAILS_DIR=".claude"
    INSTRUCTIONS_FILE="CLAUDE.md"
    CLI_CMD="claude"
    CLI_NAME="Claude Code"
    CMD_PREFIX="/specrails:"
    CLI_INSTALL_URL="https://claude.ai/download"
fi

echo -e "Provider: ${BOLD}${PROVIDER}${NC}"
echo ""

# ─────────────────────────────────────────────
# Check 1: CLI present
# ─────────────────────────────────────────────
if CLI_PATH=$(command -v "${CLI_CMD}" 2>/dev/null); then
    pass "${CLI_NAME} CLI: found (${CLI_PATH})"
else
    fail "${CLI_NAME} CLI: not found" "Install ${CLI_NAME}: ${CLI_INSTALL_URL}"
fi

# ─────────────────────────────────────────────
# Check 2: Authentication
# ─────────────────────────────────────────────
if command -v "${CLI_CMD}" &>/dev/null; then
    _authed=false
    if [[ "$PROVIDER" == "codex" ]]; then
        if [[ -n "${OPENAI_API_KEY:-}" ]]; then
            _authed=true
        elif codex login status 2>/dev/null | grep -qi "logged in"; then
            _authed=true
        elif [[ -f "${HOME}/.codex/auth.json" ]] && grep -q '"access_token"' "${HOME}/.codex/auth.json" 2>/dev/null; then
            _authed=true
        fi
        if [[ "$_authed" == "true" ]]; then
            pass "${CLI_NAME}: authenticated"
        else
            fail "${CLI_NAME}: not authenticated" "Option 1: export OPENAI_API_KEY=<your-key>  |  Option 2: codex login"
        fi
    else
        if claude config list 2>/dev/null | grep -q "api_key"; then
            _authed=true
        elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
            _authed=true
        elif [[ -f "${HOME}/.claude.json" ]] && grep -q '"oauthAccount"' "${HOME}/.claude.json" 2>/dev/null; then
            _authed=true
        fi
        if [[ "$_authed" == "true" ]]; then
            pass "${CLI_NAME}: authenticated"
        else
            fail "${CLI_NAME}: not authenticated" "Option 1: claude config set api_key <your-key>  |  Option 2: claude auth login"
        fi
    fi
fi

# ─────────────────────────────────────────────
# Check 3: Agent files present
# ─────────────────────────────────────────────
AGENTS_DIR="${PROJECT_ROOT}/${SPECRAILS_DIR}/agents"
if [[ -d "${AGENTS_DIR}" ]]; then
    AGENT_COUNT=$(find "${AGENTS_DIR}" -maxdepth 1 -name "sr-*.md" 2>/dev/null | wc -l | tr -d ' ')
    if [[ "${AGENT_COUNT}" -ge 1 ]]; then
        AGENT_NAMES=$(find "${AGENTS_DIR}" -maxdepth 1 -name "sr-*.md" -exec basename {} .md \; | tr '\n' ', ' | sed 's/, $//')
        pass "Agent files: ${AGENT_COUNT} agent(s) found (${AGENT_NAMES})"
    else
        fail "Agent files: ${SPECRAILS_DIR}/agents/ exists but no sr-*.md found" "Run specrails-core init to set up agents"
    fi
else
    fail "Agent files: ${SPECRAILS_DIR}/agents/ directory not found" "Run specrails-core init to set up agents"
fi

# ─────────────────────────────────────────────
# Check 4: Instructions file present
# ─────────────────────────────────────────────
if [[ -f "${PROJECT_ROOT}/${INSTRUCTIONS_FILE}" ]]; then
    pass "${INSTRUCTIONS_FILE}: present"
else
    fail "${INSTRUCTIONS_FILE}: missing" "Run ${CMD_PREFIX}setup inside ${CLI_NAME} to regenerate"
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
    echo -e "All ${TOTAL} checks passed. Run ${BOLD}${CMD_PREFIX}get-backlog-specs${NC} to get started."
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
echo "${TIMESTAMP}  provider=${PROVIDER}  checks=${TOTAL} passed=${PASS} failed=${FAIL}" >> "${LOG_DIR}/doctor.log"

echo ""

exit $([[ "${FAIL}" -eq 0 ]] && echo 0 || echo 1)
