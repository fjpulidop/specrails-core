#!/bin/bash
set -euo pipefail

# specrails updater
# Updates an existing specrails installation in a target repository.
# Preserves project-specific customizations (agents, personas, rules).

# Detect pipe mode (curl | bash) vs local execution
if [[ -z "${BASH_SOURCE[0]:-}" || "${BASH_SOURCE[0]:-}" == "bash" ]]; then
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
UPDATE_COMPONENT="all"
FORCE_UPDATE=false

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
        --only)
            if [[ -z "${2:-}" ]]; then
                echo "Error: --only requires a component argument." >&2
                echo "Usage: update.sh [--root-dir <path>] [--only <web-manager|commands|agents|core|all>] [--force]" >&2
                exit 1
            fi
            UPDATE_COMPONENT="$2"
            case "$UPDATE_COMPONENT" in
                web-manager|commands|agents|core|all) ;;
                *)
                    echo "Error: unknown component '$UPDATE_COMPONENT'." >&2
                    echo "Valid values: web-manager, commands, agents, core, all" >&2
                    exit 1
                    ;;
            esac
            shift 2
            ;;
        --force)
            FORCE_UPDATE=true
            shift
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Usage: update.sh [--root-dir <path>] [--only <web-manager|commands|agents|core|all>] [--force]" >&2
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
    echo -e "${YELLOW}⚠${NC}  You're running the updater from inside the specrails source repo."
    echo -e "   specrails updates a ${BOLD}target${NC} repository, not itself."
    echo ""
    read -p "   Enter the path to the target repo (or 'q' to quit): " TARGET_PATH
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
        read -p "   Continue anyway? (y/n): " CONTINUE_NOGIT
        if [[ "$CONTINUE_NOGIT" != "y" && "$CONTINUE_NOGIT" != "Y" ]]; then
            echo "   Aborted. No changes made."
            exit 0
        fi
    fi
fi

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
info() { echo -e "  ${BLUE}→${NC} $1"; }
step() { echo -e "\n${BOLD}$1${NC}"; }

AVAILABLE_VERSION="$(cat "$SCRIPT_DIR/VERSION")"

print_header() {
    local installed_ver="${1:-unknown}"
    echo ""
    echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${CYAN}║          specrails update v${AVAILABLE_VERSION}             ║${NC}"
    echo -e "${BOLD}${CYAN}║   Agent Workflow System for Claude Code      ║${NC}"
    echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${NC}"
    echo ""
    if [[ "$installed_ver" != "$AVAILABLE_VERSION" ]]; then
        info "Installed: v${installed_ver}  →  Available: v${AVAILABLE_VERSION}"
    fi
    echo ""
}

generate_manifest() {
    local version
    version="$(cat "$SCRIPT_DIR/VERSION")"

    local updated_at
    updated_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    # Write version file
    printf '%s\n' "$version" > "$REPO_ROOT/.specrails-version"

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

    # Include commands/setup.md
    local setup_checksum
    setup_checksum="sha256:$(shasum -a 256 "$SCRIPT_DIR/commands/setup.md" | awk '{print $1}')"
    if [ -n "$artifacts_json" ]; then
        artifacts_json="${artifacts_json},"
    fi
    artifacts_json="${artifacts_json}
    \"commands/setup.md\": \"${setup_checksum}\""

    cat > "$REPO_ROOT/.specrails-manifest.json" << EOF
{
  "version": "${version}",
  "installed_at": "${updated_at}",
  "artifacts": {${artifacts_json}
  }
}
EOF
}

# ─────────────────────────────────────────────
# Phase 1: Prerequisites + version check
# ─────────────────────────────────────────────

# Resolve REPO_ROOT before printing header
if [[ -z "$REPO_ROOT" ]]; then
    echo ""
    fail "Not inside a git repository and no --root-dir provided."
    echo "  Usage: update.sh [--root-dir <path>]"
    exit 1
fi

VERSION_FILE="$REPO_ROOT/.specrails-version"
AGENTS_DIR="$REPO_ROOT/.claude/agents"

# Detect installation state
INSTALLED_VERSION=""
IS_LEGACY=false

if [[ -f "$VERSION_FILE" ]]; then
    INSTALLED_VERSION="$(cat "$VERSION_FILE" | tr -d '[:space:]')"
elif [[ -d "$AGENTS_DIR" ]] && [[ -n "$(ls -A "$AGENTS_DIR" 2>/dev/null)" ]]; then
    IS_LEGACY=true
    INSTALLED_VERSION="0.1.0"
else
    echo ""
    fail "No specrails installation found. Run install.sh first."
    echo ""
    exit 1
fi

print_header "$INSTALLED_VERSION"

if [[ -n "$CUSTOM_ROOT_DIR" ]]; then
    ok "Update root (--root-dir): $REPO_ROOT"
else
    ok "Git repository root: $REPO_ROOT"
fi

# Content-aware up-to-date check (skip for legacy migrations and agent-only runs)
if [[ "$INSTALLED_VERSION" == "$AVAILABLE_VERSION" ]] && [[ "$IS_LEGACY" == false ]] && [[ "$UPDATE_COMPONENT" != "agents" ]] && [[ "$FORCE_UPDATE" == false ]]; then
    # Same version — check if any template content has actually changed
    local_manifest="$REPO_ROOT/.specrails-manifest.json"
    HAS_CHANGES=false

    if [[ -f "$local_manifest" ]]; then
        while IFS= read -r -d '' filepath; do
            relpath="templates/${filepath#"$SCRIPT_DIR/templates/"}"
            current_checksum="sha256:$(shasum -a 256 "$filepath" | awk '{print $1}')"
            manifest_checksum="$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data['artifacts'].get(sys.argv[2], ''))
except Exception:
    print('')
" "$local_manifest" "$relpath" 2>/dev/null || echo "")"

            if [[ -z "$manifest_checksum" ]] || [[ "$current_checksum" != "$manifest_checksum" ]]; then
                HAS_CHANGES=true
                break
            fi
        done < <(find "$SCRIPT_DIR/templates" -type f -not -path '*/node_modules/*' -not -name 'package-lock.json' -print0 | sort -z)

        # Also check commands/setup.md
        if [[ "$HAS_CHANGES" == false ]] && [[ -f "$SCRIPT_DIR/commands/setup.md" ]]; then
            setup_checksum="sha256:$(shasum -a 256 "$SCRIPT_DIR/commands/setup.md" | awk '{print $1}')"
            manifest_setup="$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data['artifacts'].get('commands/setup.md', ''))
except Exception:
    print('')
" "$local_manifest" 2>/dev/null || echo "")"
            if [[ "$setup_checksum" != "$manifest_setup" ]]; then
                HAS_CHANGES=true
            fi
        fi
    else
        # No manifest — can't verify, assume changes exist
        HAS_CHANGES=true
    fi

    if [[ "$HAS_CHANGES" == false ]]; then
        ok "Already up to date (v${AVAILABLE_VERSION}) — all templates match"
        echo ""
        exit 0
    else
        info "Same version (v${AVAILABLE_VERSION}) but template content has changed — updating"
    fi
fi

# ─────────────────────────────────────────────
# Phase 2: Legacy migration
# ─────────────────────────────────────────────

if [[ "$IS_LEGACY" == true ]]; then
    step "Phase 2: Legacy migration"
    warn "No .specrails-version found — assuming v0.1.0 (pre-versioning install)"
    info "Generating baseline manifest from current specrails templates..."
    generate_manifest
    # Overwrite with legacy version so the update flow sees "0.1.0 → current"
    printf '0.1.0\n' > "$VERSION_FILE"
    ok "Written .specrails-version as 0.1.0"
    ok "Written .specrails-manifest.json"
fi

# ─────────────────────────────────────────────
# Phase 3: Backup
# ─────────────────────────────────────────────

step "Phase 3: Creating backup"

BACKUP_DIR="$REPO_ROOT/.claude.specrails.backup"
UPDATE_SUCCESS=false

# Trap: on exit, if update did not succeed, warn about backup
cleanup_on_exit() {
    if [[ "$UPDATE_SUCCESS" != true ]] && [[ -d "$BACKUP_DIR" ]]; then
        echo ""
        warn "Update did not complete successfully."
        warn "Your previous .claude/ is backed up at: $BACKUP_DIR"
        warn "To restore: rm -rf \"$REPO_ROOT/.claude\" && mv \"$BACKUP_DIR\" \"$REPO_ROOT/.claude\""
        echo ""
    fi
}
trap cleanup_on_exit EXIT

rsync -a --exclude='node_modules' "$REPO_ROOT/.claude/" "$BACKUP_DIR/"
ok "Backed up .claude/ to .claude.specrails.backup/ (excluding node_modules)"

# ─────────────────────────────────────────────
# Update functions
# ─────────────────────────────────────────────

NEEDS_SETUP_UPDATE=false
FORCE_AGENTS=false

do_migrate_sr_prefix() {
    # Detect and migrate legacy installations that use unprefixed agent/command names.
    # A legacy installation is one where .claude/agents/architect.md exists (without sr- prefix).
    local agents_dir="$REPO_ROOT/.claude/agents"
    local commands_dir="$REPO_ROOT/.claude/commands"
    local memory_dir="$REPO_ROOT/.claude/agent-memory"

    if [[ ! -f "$agents_dir/architect.md" ]]; then
        return  # Nothing to migrate
    fi

    step "Migration: adding sr- prefix namespace"
    info "Legacy installation detected (unprefixed agent names). Migrating to sr- prefix..."

    local migrated_agents=0
    local migrated_commands=0
    local migrated_memory=0

    # Migrate agent files
    local known_agents=(
        "architect"
        "developer"
        "reviewer"
        "product-manager"
        "product-analyst"
        "test-writer"
        "doc-sync"
        "frontend-developer"
        "backend-developer"
        "frontend-reviewer"
        "backend-reviewer"
        "security-reviewer"
    )

    for agent in "${known_agents[@]}"; do
        local src="$agents_dir/${agent}.md"
        local dst="$agents_dir/sr-${agent}.md"
        if [[ -f "$src" ]] && [[ ! -f "$dst" ]]; then
            mv "$src" "$dst"
            info "Renamed: agents/${agent}.md → agents/sr-${agent}.md"
            ((migrated_agents++))
        fi
    done

    # Migrate persona files in .claude/agents/personas/
    local personas_dir="$agents_dir/personas"
    if [[ -d "$personas_dir" ]]; then
        while IFS= read -r -d '' persona_file; do
            local persona_basename
            persona_basename="$(basename "$persona_file")"
            # Skip files already prefixed with sr-
            if [[ "$persona_basename" == sr-* ]]; then
                continue
            fi
            local persona_dst="$personas_dir/sr-${persona_basename}"
            if [[ ! -f "$persona_dst" ]]; then
                mv "$persona_file" "$persona_dst"
                info "Renamed: personas/${persona_basename} → personas/sr-${persona_basename}"
                ((migrated_agents++))
            fi
        done < <(find "$personas_dir" -maxdepth 1 -name "*.md" -not -name "sr-*.md" -print0 2>/dev/null)
    fi

    # Create .claude/commands/sr/ and migrate workflow commands
    local workflow_commands=(
        "implement"
        "batch-implement"
        "product-backlog"
        "update-product-driven-backlog"
        "health-check"
        "compat-check"
        "refactor-recommender"
        "why"
    )

    if [[ -d "$commands_dir" ]]; then
        mkdir -p "$commands_dir/sr"
        for cmd in "${workflow_commands[@]}"; do
            local src="$commands_dir/${cmd}.md"
            local dst="$commands_dir/sr/${cmd}.md"
            if [[ -f "$src" ]] && [[ ! -f "$dst" ]]; then
                mv "$src" "$dst"
                info "Moved: commands/${cmd}.md → commands/sr/${cmd}.md"
                ((migrated_commands++))
            fi
        done
    fi

    # Migrate agent memory directories (only known agent dirs, not failures/ or explanations/)
    if [[ -d "$memory_dir" ]]; then
        for agent in "${known_agents[@]}"; do
            local src="$memory_dir/${agent}"
            local dst="$memory_dir/sr-${agent}"
            if [[ -d "$src" ]] && [[ ! -d "$dst" ]]; then
                mv "$src" "$dst"
                info "Renamed: agent-memory/${agent}/ → agent-memory/sr-${agent}/"
                ((migrated_memory++))
            fi
        done
    fi

    # Summary
    if [[ "$migrated_agents" -gt 0 ]] || [[ "$migrated_commands" -gt 0 ]] || [[ "$migrated_memory" -gt 0 ]]; then
        ok "Migration complete: ${migrated_agents} agents/personas, ${migrated_commands} commands, ${migrated_memory} memory dirs"
    else
        ok "Migration check complete — nothing to migrate"
    fi
}

do_core() {
    step "Updating core artifacts (commands, skills, setup-templates)"

    local manifest_file="$REPO_ROOT/.specrails-manifest.json"
    local updated_count=0
    local added_count=0

    # Helper: check if a source file differs from its manifest checksum
    # Returns 0 (true) if file is new or changed, 1 if unchanged
    _file_changed() {
        local source_file="$1"
        local manifest_key="$2"

        if [[ ! -f "$manifest_file" ]]; then
            return 0  # No manifest — assume changed
        fi

        local current_checksum
        current_checksum="sha256:$(shasum -a 256 "$source_file" | awk '{print $1}')"
        local manifest_checksum
        manifest_checksum="$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data['artifacts'].get(sys.argv[2], ''))
except Exception:
    print('')
" "$manifest_file" "$manifest_key" 2>/dev/null || echo "")"

        if [[ -z "$manifest_checksum" ]]; then
            return 0  # New file
        elif [[ "$current_checksum" != "$manifest_checksum" ]]; then
            return 0  # Changed
        fi
        return 1  # Unchanged
    }

    # Update /setup command (selective)
    mkdir -p "$REPO_ROOT/.claude/commands"
    if _file_changed "$SCRIPT_DIR/commands/setup.md" "commands/setup.md"; then
        cp "$SCRIPT_DIR/commands/setup.md" "$REPO_ROOT/.claude/commands/setup.md"
        ok "Updated /setup command"
        ((updated_count++))
    fi

    # Update setup templates (selective — only copy changed/new files)
    while IFS= read -r -d '' filepath; do
        local relpath
        relpath="templates/${filepath#"$SCRIPT_DIR/templates/"}"

        if _file_changed "$filepath" "$relpath"; then
            local dest="$REPO_ROOT/.claude/setup-templates/${filepath#"$SCRIPT_DIR/templates/"}"
            mkdir -p "$(dirname "$dest")"
            cp "$filepath" "$dest"

            # Determine if new or changed
            local manifest_checksum
            manifest_checksum="$(python3 -c "
import json, sys
try:
    data = json.load(open(sys.argv[1]))
    print(data['artifacts'].get(sys.argv[2], ''))
except Exception:
    print('')
" "$manifest_file" "$relpath" 2>/dev/null || echo "")"
            if [[ -z "$manifest_checksum" ]]; then
                info "New: $relpath"
                ((added_count++))
            else
                info "Changed: $relpath"
                ((updated_count++))
            fi
        fi
    done < <(find "$SCRIPT_DIR/templates" -type f -not -path '*/node_modules/*' -not -name 'package-lock.json' -print0 | sort -z)

    # Update prompts (selective)
    if [[ -d "$SCRIPT_DIR/prompts" ]] && [[ -n "$(ls -A "$SCRIPT_DIR/prompts" 2>/dev/null)" ]]; then
        while IFS= read -r -d '' filepath; do
            local relpath
            relpath="prompts/${filepath#"$SCRIPT_DIR/prompts/"}"
            local dest="$REPO_ROOT/.claude/setup-templates/prompts/${filepath#"$SCRIPT_DIR/prompts/"}"

            # Prompts aren't in manifest yet — compare directly with destination
            if [[ ! -f "$dest" ]] || ! diff -q "$filepath" "$dest" &>/dev/null; then
                mkdir -p "$(dirname "$dest")"
                cp "$filepath" "$dest"
                if [[ ! -f "$dest" ]]; then
                    info "New prompt: $relpath"
                    ((added_count++))
                else
                    info "Changed prompt: $relpath"
                    ((updated_count++))
                fi
            fi
        done < <(find "$SCRIPT_DIR/prompts" -type f -print0 | sort -z)
    fi

    # Update skills (selective)
    if [[ -d "$SCRIPT_DIR/.claude/skills" ]] && [[ -n "$(ls -A "$SCRIPT_DIR/.claude/skills" 2>/dev/null)" ]]; then
        while IFS= read -r -d '' filepath; do
            local relpath
            relpath=".claude/skills/${filepath#"$SCRIPT_DIR/.claude/skills/"}"
            local dest="$REPO_ROOT/$relpath"

            if [[ ! -f "$dest" ]] || ! diff -q "$filepath" "$dest" &>/dev/null; then
                mkdir -p "$(dirname "$dest")"
                cp "$filepath" "$dest"
                if [[ ! -f "$dest" ]]; then
                    info "New skill: $relpath"
                    ((added_count++))
                else
                    info "Changed skill: $relpath"
                    ((updated_count++))
                fi
            fi
        done < <(find "$SCRIPT_DIR/.claude/skills" -type f -print0 | sort -z)
    fi

    if [[ "$updated_count" -eq 0 ]] && [[ "$added_count" -eq 0 ]]; then
        ok "All core artifacts unchanged"
    else
        ok "Core update: ${updated_count} changed, ${added_count} new"
    fi
}

do_web_manager() {
    step "Updating web manager (Pipeline Monitor)"

    local web_manager_dir="$REPO_ROOT/.claude/web-manager"
    local source_dir="$SCRIPT_DIR/templates/web-manager"
    local has_npm=false
    if command -v npm &>/dev/null; then
        has_npm=true
    fi

    if [[ ! -d "$source_dir" ]]; then
        ok "No web manager template found — skipping"
        return
    fi

    if [[ -d "$web_manager_dir" ]]; then
        # Already installed — check for actual changes (excluding node_modules)
        local wm_changes
        wm_changes="$(diff -rq --exclude='node_modules' --exclude='.DS_Store' "$source_dir" "$web_manager_dir" 2>/dev/null || true)"

        if [[ -z "$wm_changes" ]]; then
            ok "Web manager unchanged — skipping"
            return
        fi

        local wm_changed_count
        wm_changed_count="$(echo "$wm_changes" | wc -l | tr -d ' ')"
        info "${wm_changed_count} web manager file(s) changed — syncing"

        rsync -a --delete --exclude='node_modules' \
            "$source_dir/" "$web_manager_dir/"
        ok "Synced web manager files (node_modules preserved)"

        # Only re-run npm install if package.json changed
        local needs_server_install=false
        local needs_client_install=false
        if echo "$wm_changes" | grep -q "package.json" 2>/dev/null; then
            if echo "$wm_changes" | grep -q "client/package.json" 2>/dev/null; then
                needs_client_install=true
            fi
            # Check for root package.json (not client/)
            if echo "$wm_changes" | grep -v "client/" | grep -q "package.json" 2>/dev/null; then
                needs_server_install=true
            fi
        fi

        if [[ "$has_npm" == true ]]; then
            if [[ "$needs_server_install" == true ]]; then
                info "Re-running npm install for server (package.json changed)..."
                (cd "$web_manager_dir" && npm install --silent 2>/dev/null) && {
                    ok "Server dependencies updated"
                } || {
                    warn "Server dependency install failed — run 'cd .claude/web-manager && npm install' manually"
                }
            fi
            if [[ "$needs_client_install" == true ]]; then
                info "Re-running npm install for client (package.json changed)..."
                (cd "$web_manager_dir/client" && npm install --silent 2>/dev/null) && {
                    ok "Client dependencies updated"
                } || {
                    warn "Client dependency install failed — run 'cd .claude/web-manager/client && npm install' manually"
                }
            fi
        elif [[ "$needs_server_install" == true ]] || [[ "$needs_client_install" == true ]]; then
            warn "npm not found — package.json changed but cannot install. Run 'cd .claude/web-manager && npm install' manually."
        fi
    else
        # Not installed — full install
        mkdir -p "$web_manager_dir"
        cp -r "$source_dir/"* "$web_manager_dir/"
        ok "Installed web manager to .claude/web-manager/"

        if [[ "$has_npm" == true ]]; then
            info "Installing web manager dependencies..."
            (cd "$web_manager_dir" && npm install --silent 2>/dev/null) && {
                ok "Server dependencies installed"
            } || {
                warn "Server dependency install failed — run 'cd .claude/web-manager && npm install' manually"
            }
            (cd "$web_manager_dir/client" && npm install --silent 2>/dev/null) && {
                ok "Client dependencies installed"
            } || {
                warn "Client dependency install failed — run 'cd .claude/web-manager/client && npm install' manually"
            }
        else
            warn "npm not available — skipping dependency install. Run 'cd .claude/web-manager && npm install' later."
        fi
    fi
}

do_agents() {
    step "Checking adapted artifacts (agents, rules)"

    local manifest_file="$REPO_ROOT/.specrails-manifest.json"

    if [[ ! -f "$manifest_file" ]]; then
        warn "No .specrails-manifest.json found — cannot detect template changes."
        warn "Run update.sh without --only to regenerate the manifest."
        return
    fi

    local changed_templates=()
    local new_templates=()

    # Check templates/agents/ and templates/rules/ for changes
    while IFS= read -r -d '' filepath; do
        local relpath
        relpath="templates/${filepath#"$SCRIPT_DIR/templates/"}"
        local current_checksum
        current_checksum="sha256:$(shasum -a 256 "$filepath" | awk '{print $1}')"

        # Look up this path in the manifest
        local manifest_checksum
        manifest_checksum="$(python3 -c "
import json, sys
manifest_file = sys.argv[1]
relpath = sys.argv[2]
try:
    data = json.load(open(manifest_file))
    print(data['artifacts'].get(relpath, ''))
except Exception:
    print('')
" "$manifest_file" "$relpath" 2>/dev/null || echo "")"

        if [[ -z "$manifest_checksum" ]]; then
            new_templates+=("$relpath")
        elif [[ "$current_checksum" != "$manifest_checksum" ]]; then
            changed_templates+=("$relpath")
        fi
    done < <(find "$SCRIPT_DIR/templates/agents" "$SCRIPT_DIR/templates/rules" -type f -print0 2>/dev/null | sort -z)

    # Handle changed templates
    if [[ "${#changed_templates[@]}" -gt 0 ]] || [[ "$FORCE_AGENTS" == true ]]; then
        if [[ "$FORCE_AGENTS" == true ]]; then
            info "Agent regeneration forced via --only agents."
        else
            echo ""
            warn "The following agent/rule templates have changed:"
            for t in "${changed_templates[@]}"; do
                echo "      $t"
            done
            echo ""
        fi

        local answer
        read -p "    Regenerate agents? (y/N): " answer
        if [[ "$answer" == "y" ]] || [[ "$answer" == "Y" ]]; then
            NEEDS_SETUP_UPDATE=true
            ok "Will regenerate agents via /setup --update"
        else
            warn "Workflow may break with outdated agents. Run '/setup --update' inside Claude Code when ready."
        fi
    else
        ok "All agent/rule templates unchanged — no regeneration needed"
    fi

    # Handle new templates
    if [[ "${#new_templates[@]}" -gt 0 ]]; then
        echo ""
        info "New agent/rule templates are available:"
        for t in "${new_templates[@]}"; do
            echo "      $t"
        done
        info "These will be evaluated during /setup --update"
        NEEDS_SETUP_UPDATE=true
    fi
}

do_settings() {
    step "Merging settings"

    local user_settings="$REPO_ROOT/.claude/settings.json"
    local template_settings="$SCRIPT_DIR/templates/settings/settings.json"

    if [[ -f "$user_settings" ]] && [[ -f "$template_settings" ]]; then
        if command -v python3 &>/dev/null; then
            python3 -c "
import json, sys

template_path = sys.argv[1]
user_path = sys.argv[2]

with open(template_path) as f:
    template = json.load(f)

with open(user_path) as f:
    user = json.load(f)

def merge_additive(base, overlay):
    for key, value in overlay.items():
        if key not in base:
            base[key] = value
        elif isinstance(base[key], dict) and isinstance(value, dict):
            merge_additive(base[key], value)
        elif isinstance(base[key], list) and isinstance(value, list):
            existing = set(str(i) for i in base[key])
            for item in value:
                if isinstance(item, str) and '{{' in item:
                    continue
                if str(item) not in existing:
                    base[key].append(item)
                    existing.add(str(item))
    return base

merged = merge_additive(user, template)

with open(user_path, 'w') as f:
    json.dump(merged, f, indent=2)
    f.write('\n')

" "$template_settings" "$user_settings" >/dev/null 2>&1 && ok "Merged settings.json (new keys added, existing preserved)" || {
                warn "settings.json merge failed — skipping. Inspect manually."
            }
        else
            warn "python3 not found — skipping settings.json merge."
        fi
    elif [[ ! -f "$user_settings" ]] && [[ -f "$template_settings" ]]; then
        mkdir -p "$REPO_ROOT/.claude"
        cp "$template_settings" "$user_settings"
        ok "Installed settings.json (was missing)"
    fi

    # security-exemptions.yaml: skip if already exists (preserve user exemptions)
    local user_exemptions="$REPO_ROOT/.claude/security-exemptions.yaml"
    local template_exemptions="$SCRIPT_DIR/templates/security/security-exemptions.yaml"
    if [[ ! -f "$user_exemptions" ]] && [[ -f "$template_exemptions" ]]; then
        cp "$template_exemptions" "$user_exemptions"
        ok "Installed security-exemptions.yaml (was missing)"
    else
        ok "security-exemptions.yaml preserved (user customizations kept)"
    fi
}

do_stamp() {
    step "Writing version stamp and manifest"
    generate_manifest
    ok "Updated .specrails-version to v${AVAILABLE_VERSION}"
    ok "Updated .specrails-manifest.json"
}

# ─────────────────────────────────────────────
# Phase 4: Run selected components
# ─────────────────────────────────────────────

step "Phase 4: Running update (component: ${UPDATE_COMPONENT})"

case "$UPDATE_COMPONENT" in
    all)
        do_migrate_sr_prefix
        do_core
        do_web_manager
        do_agents
        do_settings
        do_stamp
        ;;
    commands)
        do_migrate_sr_prefix
        do_core
        do_stamp
        ;;
    web-manager)
        do_web_manager
        do_stamp
        ;;
    agents)
        do_migrate_sr_prefix
        FORCE_AGENTS=true
        do_agents
        do_stamp
        ;;
    core)
        do_migrate_sr_prefix
        do_core
        do_stamp
        ;;
esac

# ─────────────────────────────────────────────
# Phase 5: Cleanup and summary
# ─────────────────────────────────────────────

step "Phase 5: Cleanup"

UPDATE_SUCCESS=true
rm -rf "$BACKUP_DIR"
ok "Backup removed"

# Clean up setup-templates if no /setup re-run is needed
if [[ "$NEEDS_SETUP_UPDATE" != true ]] && [[ -d "$REPO_ROOT/.claude/setup-templates" ]]; then
    rm -rf "$REPO_ROOT/.claude/setup-templates"
    ok "Cleaned up setup-templates (no /setup re-run needed)"
fi

echo ""
echo -e "${BOLD}${GREEN}Update complete — v${INSTALLED_VERSION} → v${AVAILABLE_VERSION}${NC}"
echo ""
echo "  Component updated: ${UPDATE_COMPONENT}"
echo ""

if [[ "$NEEDS_SETUP_UPDATE" == true ]]; then
    echo -e "${BOLD}${CYAN}Next step: regenerate adapted agents${NC}"
    echo ""
    echo "  Open Claude Code in this repo and run:"
    echo ""
    echo -e "     ${BOLD}/setup --update${NC}"
    echo ""
    echo "  Claude will re-analyze your codebase and regenerate only the"
    echo "  agents and rules whose templates have changed."
    echo ""
else
    echo -e "${BOLD}${CYAN}No agent regeneration needed.${NC}"
    echo ""
    echo "  Open Claude Code and continue working normally."
    echo ""
fi
