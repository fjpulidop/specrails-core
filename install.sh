#!/bin/bash
set -euo pipefail

# specrails installer
# Installs the agent workflow system into any repository.
# Step 1 of 2: Prerequisites + scaffold. Step 2: Run /specrails:enrich inside Claude Code.

# Detect pipe mode (curl | bash) vs local execution
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]:-}" == "bash" ]]; then
    # Running via pipe — clone repo to temp dir
    SPECRAILS_TMPDIR="$(mktemp -d)"
    trap 'rm -rf "$SPECRAILS_TMPDIR"' EXIT
    git clone --depth 1 https://github.com/fjpulidop/specrails.git "$SPECRAILS_TMPDIR/specrails" 2>/dev/null || {
        echo "Error: failed to clone specrails repository." >&2
        exit 1
    }
    SCRIPT_DIR="$SPECRAILS_TMPDIR/specrails"
else
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────

CUSTOM_ROOT_DIR=""
AUTO_YES=false
# Set SPECRAILS_SKIP_PREREQS=1 to bypass hard-exit prerequisite checks (for CI/testing).
SKIP_PREREQS="${SPECRAILS_SKIP_PREREQS:-0}"

# Provider detection results (set in Phase 1)
CLI_PROVIDER=""
SPECRAILS_DIR=""
INSTRUCTIONS_FILE=""
HAS_CLAUDE=false
HAS_CODEX=false
AGENT_TEAMS=false

# Direct-mode flags (set by bin/specrails-core.js after TUI completes)
FROM_CONFIG=false   # read provider/agent_teams from .specrails/install-config.yaml
CONFIG_PATH=""      # explicit config file path (passed after --from-config)
HAS_GUM=false       # set to true if gum CLI is available (optional UI enhancement)
TIER="full"         # install tier: full (default) or quick (template-only, no enrich)
HUB_JSON=false      # emit JSON checkpoint lines for programmatic consumption (specrails-hub)

while [[ $# -gt 0 ]]; do
    case "$1" in
        --root-dir)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --root-dir requires a path argument." >&2
                exit 1
            fi
            CUSTOM_ROOT_DIR="$2"
            shift 2
            ;;
        --yes|-y)
            AUTO_YES=true
            shift
            ;;
        --provider)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --provider requires a value (claude or codex)." >&2
                exit 1
            fi
            if [[ "$2" != "claude" && "$2" != "codex" ]]; then
                echo "Error: --provider value must be 'claude' or 'codex', got: $2" >&2
                exit 1
            fi
            CLI_PROVIDER="$2"
            shift 2
            ;;
        --from-config)
            # Config was written by the TUI; skip interactive prompts and read
            # provider + agent_teams from install-config.yaml.
            # Optional: --from-config <path>  (defaults to .specrails/install-config.yaml)
            FROM_CONFIG=true
            if [[ -n "${2:-}" && "${2:-}" != -* ]]; then
                CONFIG_PATH="${2}"
                shift 2
            else
                shift
            fi
            ;;
        --agent-teams)
            # Explicitly enable agent teams commands (alternative to config file).
            AGENT_TEAMS=true
            shift
            ;;
        --quick)
            # Template-only install; sets tier=quick in the generated config.
            TIER="quick"
            shift
            ;;
        --hub-json)
            # Emit JSON checkpoint lines for programmatic consumption by specrails-hub.
            HUB_JSON=true
            shift
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: install.sh [--root-dir <path>] [--yes|-y] [--provider <claude|codex>] [--from-config [<path>]] [--agent-teams] [--quick] [--hub-json]" >&2
            exit 1
            ;;
    esac
done

# Override REPO_ROOT if --root-dir was provided
if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    REPO_ROOT="$(cd "$CUSTOM_ROOT_DIR" 2>/dev/null && pwd)" || {
        echo "Error: --root-dir path does not exist or is not accessible: $CUSTOM_ROOT_DIR" >&2
        exit 1
    }
    if [[ ! -d "$REPO_ROOT" ]]; then
        echo "Error: --root-dir path is not a directory: $CUSTOM_ROOT_DIR" >&2
        exit 1
    fi
fi

# Detect if running from within the specrails source repo itself
if [[ -z "$CUSTOM_ROOT_DIR" && -f "$SCRIPT_DIR/install.sh" && -d "$SCRIPT_DIR/templates" && "$SCRIPT_DIR" == "$REPO_ROOT"* ]]; then
    # We're inside the specrails source — ask for target repo
    echo ""
    echo -e "${YELLOW}⚠${NC}  You're running the installer from inside the specrails source repo."
    echo -e "   specrails installs into a ${BOLD}target${NC} repository, not into itself."
    echo ""
    read -p "   Enter the path to the target repo (or 'q' to quit): " TARGET_PATH || TARGET_PATH="q"
    if [[ "$TARGET_PATH" == "q" || -z "$TARGET_PATH" ]]; then
        echo "   Aborted. No changes made."
        exit 0
    fi
    # Expand ~ and resolve path
    TARGET_PATH="${TARGET_PATH/#\~/$HOME}"
    REPO_ROOT="$(cd "$TARGET_PATH" 2>/dev/null && pwd)" || {
        echo "Error: path does not exist or is not accessible: $TARGET_PATH" >&2
        exit 1
    }
    if [[ ! -d "$REPO_ROOT/.git" ]]; then
        echo -e "${YELLOW}⚠${NC}  Warning: $REPO_ROOT does not appear to be a git repository."
        if [ "$AUTO_YES" = true ]; then CONTINUE_NOGIT="y"; else read -p "   Continue anyway? (y/n): " CONTINUE_NOGIT; fi
        if [[ "$CONTINUE_NOGIT" != "y" && "$CONTINUE_NOGIT" != "Y" ]]; then
            echo "   Aborted. No changes made."
            exit 0
        fi
    fi
fi

print_header() {
    echo ""
    echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║          specrails installer v0.1           ║${NC}"
    echo -e "${BOLD}${CYAN}║         Agent Workflow System (AI-native)    ║${NC}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
}

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }
step() { echo -e "\n${BOLD}$1${NC}"; }

generate_manifest() {
    local version
    version="$(cat "$SCRIPT_DIR/VERSION")"

    local installed_at
    installed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # Write version file
    printf '%s\n' "$version" > "$REPO_ROOT/.specrails/specrails-version"

    # Build artifact checksums for all files under templates/
    local artifacts_json=""
    local first=true
    while IFS= read -r -d '' filepath; do
        local relpath
        relpath="templates/${filepath#"$SCRIPT_DIR/templates/"}"
        local checksum
        checksum="sha256:$(shasum -a 256 "$filepath" | awk '{print $1}')"
        if [ "$first" = true ]; then
            first=false
        else
            artifacts_json="${artifacts_json},"
        fi
        artifacts_json="${artifacts_json}
    \"${relpath}\": \"${checksum}\""
    done < <(find "$SCRIPT_DIR/templates" -type f -not -path '*/node_modules/*' -not -name 'package-lock.json' -print0 | sort -z)

    # Include commands/enrich.md
    local enrich_checksum
    enrich_checksum="sha256:$(shasum -a 256 "$SCRIPT_DIR/commands/enrich.md" | awk '{print $1}')"
    if [ -n "$artifacts_json" ]; then
        artifacts_json="${artifacts_json},"
    fi
    artifacts_json="${artifacts_json}
    \"commands/specrails/enrich.md\": \"${enrich_checksum}\""

    # Include commands/doctor.md
    local doctor_checksum
    doctor_checksum="sha256:$(shasum -a 256 "$SCRIPT_DIR/commands/doctor.md" | awk '{print $1}')"
    artifacts_json="${artifacts_json},
    \"commands/specrails/doctor.md\": \"${doctor_checksum}\""

    cat > "$REPO_ROOT/.specrails/specrails-manifest.json" << EOF
{
  "version": "${version}",
  "installed_at": "${installed_at}",
  "artifacts": {${artifacts_json}
  }
}
EOF
}

# ─────────────────────────────────────────────
# Phase 1: Prerequisites
# ─────────────────────────────────────────────

print_header

step "Phase 1: Checking prerequisites"

# 1.1 Git repository
if [[ -z "$REPO_ROOT" ]]; then
    fail "Not inside a git repository and no --root-dir provided."
    echo "  Usage: install.sh [--root-dir <path>]"
    exit 1
fi
if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    ok "Install root (--root-dir): $REPO_ROOT"
else
    ok "Git repository root: $REPO_ROOT"
fi

# 1.2 Provider detection (Claude Code vs Codex)
if command -v claude &> /dev/null; then
    HAS_CLAUDE=true
fi
if command -v codex &> /dev/null; then
    HAS_CODEX=true
fi

# 1.2a Gum detection (optional UI enhancement — used in non-TUI bash paths)
if command -v gum &> /dev/null; then
    HAS_GUM=true
    ok "gum CLI: found (enhanced UI available)"
else
    # Attempt a lightweight auto-install on supported platforms (best-effort)
    _GUM_INSTALLED=false
    if command -v brew &> /dev/null; then
        info "Installing gum CLI via Homebrew (optional — adds nicer prompts)..."
        if brew install gum &>/dev/null; then
            HAS_GUM=true
            _GUM_INSTALLED=true
            ok "gum installed via Homebrew"
        fi
    fi
    if [[ "$_GUM_INSTALLED" == false ]]; then
        info "gum CLI not found — install via 'brew install gum' for enhanced prompts (optional)"
    fi
fi

if [[ "$FROM_CONFIG" == true ]]; then
    # Config was written by the TUI — read provider and agent_teams from it.
    # Resolve config path: explicit path > default location.
    if [[ -z "$CONFIG_PATH" ]]; then
        CONFIG_PATH="${REPO_ROOT}/.specrails/install-config.yaml"
    fi
    if [[ -f "$CONFIG_PATH" ]]; then
        _cfg_version=$(grep '^version:' "$CONFIG_PATH" 2>/dev/null | awk '{print $2}' | tr -d '[:space:]' || true)
        _cfg_provider=$(grep '^provider:' "$CONFIG_PATH" 2>/dev/null | awk '{print $2}' | tr -d '[:space:]' || true)
        _cfg_agent_teams=$(grep '^agent_teams:' "$CONFIG_PATH" 2>/dev/null | awk '{print $2}' | tr -d '[:space:]' || true)
        _cfg_tier=$(grep '^tier:' "$CONFIG_PATH" 2>/dev/null | awk '{print $2}' | tr -d '[:space:]' || true)
        _cfg_preset=$(grep '^\s*preset:' "$CONFIG_PATH" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '[:space:]' || true)
        _cfg_has_agents=$(grep -c '^\s*selected:' "$CONFIG_PATH" 2>/dev/null || true)

        _config_errors=0
        if [[ -z "$_cfg_version" ]]; then
            fail "Invalid config: missing required 'version' field"
            _config_errors=$(( _config_errors + 1 ))
        elif [[ "$_cfg_version" != "1" ]]; then
            fail "Invalid config: unsupported version '$_cfg_version' (expected: 1)"
            _config_errors=$(( _config_errors + 1 ))
        fi
        if [[ -z "$_cfg_provider" ]]; then
            fail "Invalid config: missing required 'provider' field"
            _config_errors=$(( _config_errors + 1 ))
        elif [[ "$_cfg_provider" != "claude" && "$_cfg_provider" != "codex" ]]; then
            fail "Invalid config: unsupported provider '$_cfg_provider' (expected: claude or codex)"
            _config_errors=$(( _config_errors + 1 ))
        fi
        if [[ "$_cfg_has_agents" -eq 0 ]]; then
            fail "Invalid config: missing required 'agents' section with 'selected' list"
            _config_errors=$(( _config_errors + 1 ))
        fi
        if [[ -n "$_cfg_tier" && "$_cfg_tier" != "full" && "$_cfg_tier" != "quick" ]]; then
            fail "Invalid config: unsupported tier '$_cfg_tier' (expected: full or quick)"
            _config_errors=$(( _config_errors + 1 ))
        fi
        if [[ -n "$_cfg_preset" && "$_cfg_preset" != "balanced" && "$_cfg_preset" != "budget" && "$_cfg_preset" != "max" ]]; then
            fail "Invalid config: unsupported preset '$_cfg_preset' (expected: balanced, budget, or max)"
            _config_errors=$(( _config_errors + 1 ))
        fi

        # Warn about unknown agents in selected list
        if [[ "$_cfg_has_agents" -gt 0 ]]; then
            _selected_line=$(grep '^\s*selected:' "$CONFIG_PATH" 2>/dev/null | head -1 || true)
            if echo "$_selected_line" | grep -q '\[' 2>/dev/null; then
                _selected_agents=$(echo "$_selected_line" | sed 's/.*\[//;s/\].*//;s/,/\n/g' | tr -d ' ')
            else
                _selected_agents=$(grep -A100 '^\s*selected:' "$CONFIG_PATH" 2>/dev/null \
                    | tail -n +2 | grep '^\s*-\s*' | sed 's/^\s*-\s*//' | tr -d ' ' || true)
            fi
            while IFS= read -r _agent_name; do
                [[ -z "$_agent_name" ]] && continue
                if [[ ! -f "$SCRIPT_DIR/templates/agents/${_agent_name}.md" ]]; then
                    warn "Unknown agent in selected list: ${_agent_name}"
                fi
            done <<< "$_selected_agents"
        fi

        if [[ "$_config_errors" -gt 0 ]]; then
            fail "Config validation failed with ${_config_errors} error(s) — aborting"
            exit 1
        fi

        if [[ -n "$_cfg_provider" ]]; then
            CLI_PROVIDER="$_cfg_provider"
            ok "Provider: $CLI_PROVIDER (from install-config.yaml)"
        fi
        if [[ "$_cfg_agent_teams" == "true" ]]; then
            AGENT_TEAMS=true
        fi
        if [[ -n "$_cfg_tier" ]]; then
            TIER="$_cfg_tier"
        fi
    else
        warn "install-config.yaml not found at $CONFIG_PATH — falling back to auto-detection"
        FROM_CONFIG=false
    fi
fi

if [[ "$FROM_CONFIG" != true ]]; then
    if [[ -n "$CLI_PROVIDER" ]]; then
        # --provider flag was set explicitly — skip interactive detection
        ok "Provider: $CLI_PROVIDER (--provider flag)"
    elif [ "$HAS_CLAUDE" = true ] && [ "$HAS_CODEX" = true ]; then
        echo ""
        echo -e "  ${BOLD}Both Claude Code and Codex detected.${NC}"
        if [ "$AUTO_YES" = true ]; then
            CLI_PROVIDER="claude"
            info "Auto-selected Claude Code (--yes flag active)"
        else
            echo ""
            echo "    Which provider would you like to use?"
            echo "      1) Claude Code (claude)  → output to .claude/"
            echo "      2) Codex (codex)         → output to .codex/"
            echo ""
            read -p "    Select provider (1 or 2, default: 1): " PROVIDER_CHOICE || PROVIDER_CHOICE="1"
            PROVIDER_CHOICE="${PROVIDER_CHOICE:-1}"
            if [[ "$PROVIDER_CHOICE" == "2" ]]; then
                CLI_PROVIDER="codex"
            else
                CLI_PROVIDER="claude"
            fi
        fi
        ok "Provider: $CLI_PROVIDER"
    elif [ "$HAS_CLAUDE" = true ]; then
        CLI_PROVIDER="claude"
        CLAUDE_VERSION=$(claude --version 2>/dev/null || echo "unknown")
        ok "Claude Code CLI: $CLAUDE_VERSION"
    elif [ "$HAS_CODEX" = true ]; then
        CLI_PROVIDER="codex"
        CODEX_VERSION=$(codex --version 2>/dev/null || echo "unknown")
        ok "Codex CLI: $CODEX_VERSION"
    elif [[ "$SKIP_PREREQS" == "1" ]]; then
        CLI_PROVIDER="claude"
        warn "No AI CLI found (skipped — SPECRAILS_SKIP_PREREQS=1)"
    else
        fail "No AI CLI found (claude or codex)."
        echo ""
        echo "    Install Claude Code: https://claude.ai/download"
        echo "    Install Codex:       https://github.com/openai/codex"
        exit 1
    fi
fi

# Derive output directory and instruction file from provider
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    SPECRAILS_DIR=".codex"
    INSTRUCTIONS_FILE="AGENTS.md"
else
    SPECRAILS_DIR=".claude"
    INSTRUCTIONS_FILE="CLAUDE.md"
fi

# 1.2b Agent Teams opt-in (Claude Code only)
if [[ "$CLI_PROVIDER" == "claude" ]]; then
    if [[ "$FROM_CONFIG" == true || "$AGENT_TEAMS" == true ]]; then
        # Already resolved from config or --agent-teams flag
        if [[ "$AGENT_TEAMS" == true ]]; then
            ok "Agent Teams commands: enabled (from install-config.yaml)"
            echo ""
            info "Remember to set the feature flag before using these commands:"
            echo ""
            echo "    export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
            echo ""
        else
            info "Agent Teams commands: skipped (from install-config.yaml)"
        fi
    elif [ "$AUTO_YES" = true ]; then
        # --yes flag: default to NOT installing (opt-in, not opt-out)
        AGENT_TEAMS=false
        info "Agent Teams commands: skipped (opt-in, use interactive mode to enable)"
    else
        echo ""
        echo -e "  ${BOLD}Agent Teams commands are available (experimental):${NC}"
        echo "    /specrails:team-review — Multi-perspective code review with AI reviewers"
        echo "    /specrails:team-debug  — Collaborative debugging with competing hypotheses"
        echo ""
        echo "  These require Claude Code Agent Teams (experimental feature)."
        read -p "  Install Agent Teams commands? (y/n, default: n): " INSTALL_AGENT_TEAMS || INSTALL_AGENT_TEAMS="n"
        if [[ "$INSTALL_AGENT_TEAMS" == "y" || "$INSTALL_AGENT_TEAMS" == "Y" ]]; then
            AGENT_TEAMS=true
            ok "Agent Teams commands will be installed"
            echo ""
            info "Remember to set the feature flag before using these commands:"
            echo ""
            echo "    export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"
            echo ""
        else
            AGENT_TEAMS=false
            info "Agent Teams commands: skipped"
        fi
    fi
fi

# 1.3 API key / authentication (provider-specific)
if [[ "$CLI_PROVIDER" == "claude" ]]; then
    CLAUDE_AUTHED=false
    if claude config list 2>/dev/null | grep -q "api_key"; then
        CLAUDE_AUTHED=true
    elif [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
        CLAUDE_AUTHED=true
    elif [[ -f "${HOME}/.claude.json" ]] && grep -q '"oauthAccount"' "${HOME}/.claude.json" 2>/dev/null; then
        CLAUDE_AUTHED=true
    fi

    if [[ "$CLAUDE_AUTHED" == "true" ]]; then
        ok "Claude: authenticated"
    elif [[ "$SKIP_PREREQS" == "1" ]]; then
        warn "Claude authentication not found (skipped — SPECRAILS_SKIP_PREREQS=1)"
    else
        fail "No Claude authentication found."
        echo ""
        echo "    Option 1 (API key): claude config set api_key <your-key>"
        echo "    Option 2 (OAuth):   claude auth login"
        exit 1
    fi
else
    # Codex
    CODEX_AUTHED=false
    if [[ -n "${OPENAI_API_KEY:-}" ]]; then
        CODEX_AUTHED=true
    elif codex login status 2>/dev/null | grep -qi "logged in"; then
        CODEX_AUTHED=true
    elif [[ -f "${HOME}/.codex/auth.json" ]] && grep -q '"access_token"' "${HOME}/.codex/auth.json" 2>/dev/null; then
        CODEX_AUTHED=true
    fi

    if [[ "$CODEX_AUTHED" == "true" ]]; then
        ok "Codex: authenticated"
    elif [[ "$SKIP_PREREQS" == "1" ]]; then
        warn "Codex authentication not found (skipped — SPECRAILS_SKIP_PREREQS=1)"
    else
        fail "No Codex authentication found."
        echo ""
        echo "    Option 1 (API key): export OPENAI_API_KEY=<your-key>"
        echo "    Option 2 (OAuth):   codex login"
        exit 1
    fi
fi

# 1.4 npm
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version 2>/dev/null)
    ok "npm: v$NPM_VERSION"
    HAS_NPM=true
else
    warn "npm not found. OpenSpec CLI will be unavailable."
    echo "    Install npm: https://docs.npmjs.com/downloading-and-installing-node-js-and-npm"
    HAS_NPM=false
fi

# 1.5 OpenSpec CLI
if command -v openspec &> /dev/null; then
    OPENSPEC_VERSION=$(openspec --version 2>/dev/null || echo "unknown")
    ok "OpenSpec CLI: $OPENSPEC_VERSION"
    HAS_OPENSPEC=true
elif [ -f "$REPO_ROOT/node_modules/.bin/openspec" ]; then
    ok "OpenSpec CLI: found in node_modules"
    HAS_OPENSPEC=true
else
    warn "OpenSpec CLI not found."
    if [ "$HAS_NPM" = true ]; then
        if [ "$AUTO_YES" = true ]; then INSTALL_OPENSPEC="y"; else read -p "    Install OpenSpec CLI globally? (y/n): " INSTALL_OPENSPEC || INSTALL_OPENSPEC="n"; fi
        if [ "$INSTALL_OPENSPEC" = "y" ] || [ "$INSTALL_OPENSPEC" = "Y" ]; then
            info "Installing OpenSpec CLI..."
            npm install -g @openspec/cli 2>/dev/null && {
                ok "OpenSpec CLI installed"
                HAS_OPENSPEC=true
            } || {
                warn "Global install failed. Trying local..."
                cd "$REPO_ROOT" && npm install @openspec/cli 2>/dev/null && {
                    ok "OpenSpec CLI installed locally"
                    HAS_OPENSPEC=true
                } || {
                    fail "Could not install OpenSpec CLI."
                    HAS_OPENSPEC=false
                }
            }
        else
            warn "Skipping OpenSpec install. Spec-driven workflow will be limited."
            HAS_OPENSPEC=false
        fi
    else
        warn "Cannot install OpenSpec without npm."
        HAS_OPENSPEC=false
    fi
fi

# 1.6 GitHub CLI (optional)
if command -v gh &> /dev/null; then
    if gh auth status &> /dev/null; then
        ok "GitHub CLI: authenticated"
        HAS_GH=true
    else
        warn "GitHub CLI installed but not authenticated. Run: gh auth login"
        HAS_GH=false
    fi
else
    warn "GitHub CLI (gh) not found. GitHub Issues backlog will be unavailable."
    HAS_GH=false
fi

# 1.7 OSS detection (requires gh auth; degrades gracefully)
IS_OSS=false
HAS_PUBLIC_REPO=false
HAS_CI=false
HAS_CONTRIBUTING=false

if [ "$HAS_GH" = true ]; then
    _REPO_PRIVATE=$(gh repo view --json isPrivate --jq '.isPrivate' 2>/dev/null || echo "unknown")
    if [ "$_REPO_PRIVATE" = "false" ]; then
        HAS_PUBLIC_REPO=true
    fi
    if ls "$REPO_ROOT/.github/workflows/"*.yml > /dev/null 2>&1; then
        HAS_CI=true
    fi
    if [ -f "$REPO_ROOT/CONTRIBUTING.md" ] || [ -f "$REPO_ROOT/.github/CONTRIBUTING.md" ]; then
        HAS_CONTRIBUTING=true
    fi
    if [ "$HAS_PUBLIC_REPO" = true ] && [ "$HAS_CI" = true ] && [ "$HAS_CONTRIBUTING" = true ]; then
        IS_OSS=true
        ok "OSS project detected (public repo + CI + CONTRIBUTING.md)"
    fi
fi

# 1.8 JIRA CLI (optional)
if command -v jira &> /dev/null; then
    ok "JIRA CLI: found"
    HAS_JIRA=true
else
    HAS_JIRA=false
    # Don't warn here — JIRA is only relevant if chosen during /specrails:enrich.
    # If the user selects JIRA in /specrails:enrich and it's not installed, the enrich
    # wizard will offer to install it (go-jira via brew/go, or Atlassian CLI).
fi

# ─────────────────────────────────────────────
# Phase 2: Detect existing setup
# ─────────────────────────────────────────────

step "Phase 2: Detecting existing setup"

EXISTING_SETUP=false

if [ -d "$REPO_ROOT/$SPECRAILS_DIR" ]; then
    if [ -d "$REPO_ROOT/$SPECRAILS_DIR/agents" ] && [ "$(ls -A "$REPO_ROOT/$SPECRAILS_DIR/agents" 2>/dev/null)" ]; then
        warn "Existing $SPECRAILS_DIR/agents/ found with content"
        EXISTING_SETUP=true
    fi
    if [ -d "$REPO_ROOT/$SPECRAILS_DIR/commands" ] && [ "$(ls -A "$REPO_ROOT/$SPECRAILS_DIR/commands" 2>/dev/null)" ]; then
        warn "Existing $SPECRAILS_DIR/commands/ found with content"
        EXISTING_SETUP=true
    fi
    if [ -d "$REPO_ROOT/$SPECRAILS_DIR/rules" ] && [ "$(ls -A "$REPO_ROOT/$SPECRAILS_DIR/rules" 2>/dev/null)" ]; then
        warn "Existing $SPECRAILS_DIR/rules/ found with content"
        EXISTING_SETUP=true
    fi
fi

if [ -d "$REPO_ROOT/openspec" ]; then
    warn "Existing openspec/ directory found"
    EXISTING_SETUP=true
fi

if [ "$EXISTING_SETUP" = true ]; then
    echo ""
    warn "This repo already has some agent/command/openspec artifacts."
    if [ "$AUTO_YES" = true ]; then CONTINUE="y"; else read -p "    Continue and merge with existing setup? (y/n): " CONTINUE || CONTINUE="n"; fi
    if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
        info "Aborted. No changes made."
        exit 0
    fi
else
    ok "Clean repo — no existing .claude/ or openspec/ artifacts"
fi

# ─────────────────────────────────────────────
# Phase 3: Install artifacts
# ─────────────────────────────────────────────

step "Phase 3: Installing specrails artifacts"

# Create directory structure
mkdir -p "$REPO_ROOT/specrails"
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    # Codex: install as Agent Skills (Codex doesn't support .codex/commands/)
    mkdir -p "$REPO_ROOT/.agents/skills/enrich"
    mkdir -p "$REPO_ROOT/.agents/skills/doctor"
else
    mkdir -p "$REPO_ROOT/$SPECRAILS_DIR/commands/specrails"
fi
mkdir -p "$REPO_ROOT/.specrails/setup-templates/agents"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/commands"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/skills"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/rules"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/personas"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/claude-md"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/settings"
mkdir -p "$REPO_ROOT/.specrails/setup-templates/prompts"
mkdir -p "$REPO_ROOT/$SPECRAILS_DIR/agent-memory/explanations"

# Copy the /specrails:enrich and /specrails:doctor commands (or skills for Codex)
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    # Codex uses Agent Skills in .agents/skills/<name>/SKILL.md
    {
        echo '---'
        echo 'name: enrich'
        echo 'description: "Interactive wizard to configure the full specrails agent workflow system for this repository. Supports config-driven mode for direct installation from a pre-built config file."'
        echo 'license: MIT'
        echo 'compatibility: "Requires npm, git."'
        echo 'metadata:'
        echo '  author: specrails'
        echo '  version: "1.0"'
        echo '---'
        echo ''
        cat "$SCRIPT_DIR/commands/enrich.md"
    } > "$REPO_ROOT/.agents/skills/enrich/SKILL.md"
    ok "Installed \$enrich skill"

    {
        echo '---'
        echo 'name: doctor'
        echo 'description: "Health check for the specrails agent workflow system — validates agents, commands, rules, and configuration."'
        echo 'license: MIT'
        echo 'compatibility: "Requires npm, git."'
        echo 'metadata:'
        echo '  author: specrails'
        echo '  version: "1.0"'
        echo '---'
        echo ''
        cat "$SCRIPT_DIR/commands/doctor.md"
    } > "$REPO_ROOT/.agents/skills/doctor/SKILL.md"
    ok "Installed \$doctor skill"
else
    # Claude Code uses commands in .claude/commands/specrails/ (namespaced as /specrails:*)
    cp "$SCRIPT_DIR/commands/enrich.md" "$REPO_ROOT/$SPECRAILS_DIR/commands/specrails/enrich.md"
    ok "Installed /specrails:enrich command"

    cp "$SCRIPT_DIR/commands/doctor.md" "$REPO_ROOT/$SPECRAILS_DIR/commands/specrails/doctor.md"
    ok "Installed /specrails:doctor command"
fi

# Install bin/doctor.sh for standalone use
mkdir -p "$REPO_ROOT/.specrails/bin"
cp "$SCRIPT_DIR/bin/doctor.sh" "$REPO_ROOT/.specrails/bin/doctor.sh"
chmod +x "$REPO_ROOT/.specrails/bin/doctor.sh"
ok "Installed specrails doctor (bin/doctor.sh)"

# Write install-config.yaml: copy from --from-config source if provided,
# otherwise write defaults. Ensures a config file always exists after install
# so /specrails:enrich --from-config works regardless of how the installer was invoked.
_install_config="${REPO_ROOT}/.specrails/install-config.yaml"
if [[ "$FROM_CONFIG" == true && -n "$CONFIG_PATH" && -f "$CONFIG_PATH" && "$CONFIG_PATH" != "$_install_config" ]]; then
    cp "$CONFIG_PATH" "$_install_config"
    ok "Copied install-config.yaml from ${CONFIG_PATH}"
elif [[ ! -f "$_install_config" ]]; then
    _ic_provider="${CLI_PROVIDER:-claude}"
    _ic_tier="${TIER:-full}"
    _ic_agent_teams="${AGENT_TEAMS:-false}"
    cat > "$_install_config" << YAML
# specrails install config — generated during install (defaults)
# Re-run: npx specrails-core@latest init  to regenerate with TUI
version: 1
provider: ${_ic_provider}
tier: ${_ic_tier}
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-test-writer, sr-product-manager]
  excluded: [sr-frontend-developer, sr-backend-developer, sr-frontend-reviewer, sr-backend-reviewer, sr-security-reviewer, sr-performance-reviewer, sr-product-analyst, sr-doc-sync, sr-merge-resolver]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
quick_context:
  product_description: ""
  target_users: ""
agent_teams: ${_ic_agent_teams}
YAML
    ok "Written .specrails/install-config.yaml (defaults)"
fi

# Copy templates (includes commands, skills, agents, rules, personas, settings)
# Use tar to exclude node_modules and package-lock.json for performance
tar -C "$SCRIPT_DIR/templates" --exclude='node_modules' --exclude='package-lock.json' -cf - . \
    | tar -C "$REPO_ROOT/.specrails/setup-templates/" -xf -
ok "Installed setup templates (commands + skills)"

# Filter agent templates to only those listed in agents.selected (when --from-config is active).
# This allows hub or the TUI to pre-select a subset of agents before enrichment.
if [[ "$FROM_CONFIG" == true ]]; then
    _cfg_to_read="${CONFIG_PATH:-${REPO_ROOT}/.specrails/install-config.yaml}"
    if [[ -f "$_cfg_to_read" ]]; then
        # Parse selected agents from inline YAML list: selected: [sr-architect, sr-developer, ...]
        _selected_raw=$(grep '^  selected:' "$_cfg_to_read" | sed 's/.*\[//;s/\].*//;s/,/ /g' || true)
        if [[ -n "$_selected_raw" ]]; then
            _agents_dir="${REPO_ROOT}/.specrails/setup-templates/agents"
            _removed=0
            for _agent_file in "$_agents_dir/"*.md; do
                [[ -f "$_agent_file" ]] || continue
                _agent_name="$(basename "$_agent_file" .md)"
                _in_selected=false
                for _sel in $_selected_raw; do
                    # Strip whitespace/commas from parsed token
                    _sel="${_sel//,/}"
                    _sel="${_sel// /}"
                    if [[ "$_sel" == "$_agent_name" ]]; then
                        _in_selected=true
                        break
                    fi
                done
                if [[ "$_in_selected" == false ]]; then
                    rm -f "$_agent_file"
                    (( _removed++ )) || true
                fi
            done
            if (( _removed > 0 )); then
                ok "Agent templates filtered: removed ${_removed} excluded agent(s)"
            fi
        fi

        # Apply defaults.model to all agent templates when present.
        # Handles both inline "defaults: { model: haiku }" and block "defaults:\n  model: haiku"
        _cfg_default_model=""
        _defaults_line=$(grep '^\s*defaults:' "$_cfg_to_read" 2>/dev/null | head -1 || true)
        if echo "$_defaults_line" | grep -q 'model:' 2>/dev/null; then
            _cfg_default_model=$(echo "$_defaults_line" | sed 's/.*model:[[:space:]]*//' | awk '{print $1}' | tr -d '}[:space:]')
        else
            _cfg_default_model=$(sed -n '/^\s*defaults:/,/^\s*[a-z]/{ /^\s*model:/p; }' "$_cfg_to_read" 2>/dev/null | awk '{print $2}' | tr -d '[:space:]' || true)
        fi
        if [[ -n "$_cfg_default_model" ]]; then
            for _agent_file in "$_agents_dir/"*.md; do
                [[ -f "$_agent_file" ]] || continue
                sed -i.bak "s/^model: .*/model: ${_cfg_default_model}/" "$_agent_file" && rm -f "${_agent_file}.bak"
            done
        fi

        # Apply model overrides to agent frontmatter when present.
        # Overrides YAML format: "  overrides:\n    sr-architect: opus"
        _in_overrides=false
        while IFS= read -r _line; do
            if [[ "$_line" =~ ^[[:space:]]*overrides: ]]; then
                # Check if overrides are on same line: overrides: { sr-architect: opus }
                if [[ "$_line" =~ \{.*\} ]]; then
                    _inline=$(echo "$_line" | sed 's/.*{//;s/}.*//;s/,/ /g')
                    for _pair in $_inline; do
                        _key="${_pair%%:*}"
                        _val="${_pair##*:}"
                        _agent_file="${REPO_ROOT}/.specrails/setup-templates/agents/${_key}.md"
                        if [[ -f "$_agent_file" ]]; then
                            sed -i.bak "s/^model: .*/model: ${_val}/" "$_agent_file" && rm -f "${_agent_file}.bak"
                        fi
                    done
                    _in_overrides=false
                else
                    _in_overrides=true
                fi
            elif [[ "$_in_overrides" == true ]]; then
                if [[ "$_line" =~ ^[[:space:]]{4}([a-z0-9_-]+):[[:space:]]*([a-z]+) ]]; then
                    _key="${BASH_REMATCH[1]}"
                    _val="${BASH_REMATCH[2]}"
                    _agent_file="${REPO_ROOT}/.specrails/setup-templates/agents/${_key}.md"
                    if [[ -f "$_agent_file" ]]; then
                        sed -i.bak "s/^model: .*/model: ${_val}/" "$_agent_file" && rm -f "${_agent_file}.bak"
                    fi
                elif [[ ! "$_line" =~ ^[[:space:]]{4} ]]; then
                    _in_overrides=false
                fi
            fi
        done < "$_cfg_to_read"
    fi
fi

# Write OSS detection results for /specrails:enrich
cat > "$REPO_ROOT/.specrails/setup-templates/.oss-detection.json" << EOF
{
  "is_oss": $IS_OSS,
  "signals": {
    "public_repo": $HAS_PUBLIC_REPO,
    "has_ci": $HAS_CI,
    "has_contributing": $HAS_CONTRIBUTING
  }
}
EOF
ok "OSS detection results written"

# Write provider detection results for /specrails:enrich
cat > "$REPO_ROOT/.specrails/setup-templates/.provider-detection.json" << EOF
{
  "cli_provider": "$CLI_PROVIDER",
  "specrails_dir": "$SPECRAILS_DIR",
  "instructions_file": "$INSTRUCTIONS_FILE",
  "agent_teams": $AGENT_TEAMS
}
EOF
ok "Provider detection results written ($CLI_PROVIDER → .specrails/setup-templates/)"

# Copy security exemptions config (skip if already exists — preserve user exemptions)
if [ ! -f "${REPO_ROOT}/$SPECRAILS_DIR/security-exemptions.yaml" ]; then
    cp "${SCRIPT_DIR}/templates/security/security-exemptions.yaml" "${REPO_ROOT}/$SPECRAILS_DIR/security-exemptions.yaml"
    ok "Created $SPECRAILS_DIR/security-exemptions.yaml"
fi

# Copy prompts
if [ -d "$SCRIPT_DIR/prompts" ] && [ "$(ls -A "$SCRIPT_DIR/prompts" 2>/dev/null)" ]; then
    cp -r "$SCRIPT_DIR/prompts/"* "$REPO_ROOT/.specrails/setup-templates/prompts/"
    ok "Installed prompts"
fi

# Initialize OpenSpec if available and not already initialized
if [ "$HAS_OPENSPEC" = true ] && [ ! -d "$REPO_ROOT/openspec" ]; then
    info "Initializing OpenSpec..."
    cd "$REPO_ROOT" && openspec init 2>/dev/null && {
        ok "OpenSpec initialized"
    } || {
        warn "OpenSpec init failed — you can run 'openspec init' manually later"
    }
fi

# ─────────────────────────────────────────────
# Phase 3b: Write version and manifest
# ─────────────────────────────────────────────

step "Phase 3b: Writing version and manifest"

generate_manifest
ok "Written .specrails/specrails-version ($(cat "$REPO_ROOT/.specrails/specrails-version"))"
ok "Written .specrails/specrails-manifest.json"

# ─────────────────────────────────────────────
# Phase 4: Summary & next steps
# ─────────────────────────────────────────────

step "Phase 4: Installation complete"

echo ""
echo -e "${BOLD}${GREEN}Installation summary:${NC}"
echo ""
echo "  Provider: $CLI_PROVIDER → output to $SPECRAILS_DIR/"
if [[ "$AGENT_TEAMS" == "true" ]]; then
    echo "  Agent Teams: installed (/specrails:team-review, /specrails:team-debug)"
    echo "  Feature flag: CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 (required)"
fi
echo ""
echo "  Files installed:"
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    echo "    .agents/skills/enrich/SKILL.md       ← The \$enrich skill"
    echo "    .agents/skills/doctor/SKILL.md       ← The \$doctor skill"
else
    echo "    $SPECRAILS_DIR/commands/specrails/enrich.md  ← The /specrails:enrich command"
fi
echo "    .specrails/setup-templates/              ← Templates: commands + skills (temporary, removed after enrich)"
echo "    .specrails/specrails-version             ← Installed specrails version"
echo "    .specrails/specrails-manifest.json       ← Artifact checksums for update detection"
echo ""

echo -e "${BOLD}Prerequisites:${NC}"
echo ""
[ "$HAS_NPM" = true ]      && ok "npm"        || warn "npm (optional)"
[ "$HAS_OPENSPEC" = true ]  && ok "OpenSpec"    || warn "OpenSpec (optional)"
[ "$HAS_GH" = true ]        && ok "GitHub CLI"  || warn "GitHub CLI (optional, for GitHub Issues backlog)"
[ "$HAS_JIRA" = true ]      && ok "JIRA CLI"    || info "JIRA CLI not found (optional, for JIRA backlog)"
echo ""

echo -e "${BOLD}${CYAN}Next steps:${NC}"
echo ""
echo "  1. Open $CLI_PROVIDER in this repo:"
echo ""
echo -e "     ${BOLD}cd $REPO_ROOT && $CLI_PROVIDER${NC}"
echo ""
echo "  2. Run the enrich wizard:"
echo ""
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    echo -e "     ${BOLD}\$enrich${NC}"
else
    echo -e "     ${BOLD}/specrails:enrich${NC}"
fi
echo ""
if [[ "$CLI_PROVIDER" == "codex" ]]; then
    echo "  Codex will analyze your codebase, ask about your users,"
else
    echo "  Claude will analyze your codebase, ask about your users,"
fi
echo "  research the competitive landscape, and generate all agents,"
echo "  commands, rules, and personas adapted to your project."
echo ""
