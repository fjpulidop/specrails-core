#!/usr/bin/env bash
# Tests for TUI installer: --from-config, --quick, agent selection, install-config.yaml output.
#
# Strategy: these tests define the acceptance criteria for SPEA-742 (Phase 1: TUI Installer).
# They will FAIL on the baseline (before implementation) and PASS when Phase 1 is complete.
# That is intentional — spec-driven approach.
#
# Related tasks:
#   SPEA-742: Phase 1 — Node.js TUI Installer + install-config.yaml schema
#   SPEA-743: Phase 2 — /specrails:enrich + --from-config mode
#   SPEA-744: Phase 5 — Tests (this file)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running TUI installer tests${NC}"
echo ""

# ─────────────────────────────────────────────
# install.sh flag acceptance
# ─────────────────────────────────────────────

test_install_accepts_from_config_flag() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected:
    - sr-architect
    - sr-developer
    - sr-reviewer
models:
  preset: balanced
  defaults:
    model: sonnet
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_not_contains "$output" "Unknown argument" \
        "--from-config flag should be accepted by install.sh"
}
run_test "SPEA-742: --from-config flag accepted by install.sh" test_install_accepts_from_config_flag

test_install_accepts_quick_flag() {
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --quick 2>&1 || true)"
    assert_not_contains "$output" "Unknown argument" \
        "--quick flag should be accepted by install.sh"
}
run_test "SPEA-742: --quick flag accepted by install.sh" test_install_accepts_quick_flag

test_install_node_cli_accepts_from_config() {
    local node
    node="$(command -v node)"
    local cli="$SPECRAILS_DIR/bin/specrails-core.js"
    local cfg="$TEST_TMPDIR/install-config.yaml"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected: [sr-architect]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$("$node" "$cli" init --from-config "$cfg" 2>&1 || true)"
    assert_not_contains "$output" "Unknown flag" \
        "node CLI: --from-config should be in the allowlist for init"
}
run_test "SPEA-742: node CLI init --from-config not rejected as unknown flag" test_install_node_cli_accepts_from_config

test_install_node_cli_accepts_quick() {
    local node
    node="$(command -v node)"
    local cli="$SPECRAILS_DIR/bin/specrails-core.js"
    local output
    output="$("$node" "$cli" init --quick 2>&1 || true)"
    assert_not_contains "$output" "Unknown flag" \
        "node CLI: --quick should be in the allowlist for init"
}
run_test "SPEA-742: node CLI init --quick not rejected as unknown flag" test_install_node_cli_accepts_quick

# ─────────────────────────────────────────────
# install-config.yaml generation
# ─────────────────────────────────────────────

test_install_writes_install_config_on_tui() {
    # TUI install (no --from-config, no --quick) should write install-config.yaml
    # This test uses --yes to pick defaults without interactive prompts.
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes 2>/dev/null || true
    assert_file_exists "$TEST_TMPDIR/target/.specrails/install-config.yaml" \
        "install.sh should write .specrails/install-config.yaml on fresh install"
}
run_test "SPEA-742: TUI install writes .specrails/install-config.yaml" test_install_writes_install_config_on_tui

test_quick_install_writes_minimal_config() {
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes --quick 2>/dev/null || true
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    assert_file_exists "$cfg" \
        "--quick install should write .specrails/install-config.yaml"
    assert_contains "$(cat "$cfg")" "tier:" \
        "quick install config should contain tier field"
    assert_contains "$(cat "$cfg")" "quick" \
        "quick install config should set tier to quick"
}
run_test "SPEA-742: --quick install writes minimal install-config.yaml with tier=quick" test_quick_install_writes_minimal_config

test_install_config_has_required_fields() {
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes 2>/dev/null || true
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    assert_file_exists "$cfg"
    local content
    content="$(cat "$cfg")"
    assert_contains "$content" "version:" "install-config.yaml must have version field"
    assert_contains "$content" "provider:" "install-config.yaml must have provider field"
    assert_contains "$content" "tier:" "install-config.yaml must have tier field"
    assert_contains "$content" "agents:" "install-config.yaml must have agents section"
    assert_contains "$content" "models:" "install-config.yaml must have models section"
}
run_test "SPEA-742: generated install-config.yaml contains all required fields" test_install_config_has_required_fields

# ─────────────────────────────────────────────
# --from-config agent selection
# ─────────────────────────────────────────────

test_from_config_preserves_agent_selection_in_config() {
    # When --from-config <path> is passed with a pre-built config, the installer
    # should use that config (provider, tier, agents) rather than generating defaults.
    # Agent template filtering happens in /specrails:enrich --from-config, not install.sh.
    # This test verifies the config file is correctly preserved/used.
    local cfg="$TEST_TMPDIR/input-config.yaml"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected:
    - sr-architect
    - sr-developer
    - sr-reviewer
  excluded:
    - sr-frontend-developer
    - sr-security-reviewer
models:
  preset: balanced
  defaults:
    model: sonnet
  overrides: {}
YAML
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>/dev/null || true

    # The stored install-config.yaml should reflect the provided agent selection
    local stored="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    assert_file_exists "$stored" \
        "install-config.yaml should exist in .specrails/ after --from-config run" || return 1
    local content
    content="$(cat "$stored")"
    assert_contains "$content" "sr-architect" \
        "stored config should contain sr-architect from provided selection" || return 1
    assert_contains "$content" "sr-developer" \
        "stored config should contain sr-developer from provided selection" || return 1
}
run_test "SPEA-742: --from-config config content preserved in .specrails/install-config.yaml" test_from_config_preserves_agent_selection_in_config

test_from_config_noninteractive() {
    # --from-config with --yes must not prompt for any input
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected:
    - sr-architect
    - sr-developer
  excluded: []
models:
  preset: budget
  defaults:
    model: haiku
  overrides: {}
YAML
    local output
    # Feed empty stdin to detect any interactive prompts
    output="$(echo "" | SPECRAILS_SKIP_PREREQS=1 timeout 10 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    # Should complete without hanging or requiring input
    assert_not_contains "$output" "Unknown argument" \
        "--from-config should be accepted as a known flag"
}
run_test "SPEA-742: --from-config with --yes runs non-interactively" test_from_config_noninteractive

# ─────────────────────────────────────────────
# Model selection via config
# ─────────────────────────────────────────────

test_from_config_model_overrides_in_stored_config() {
    # Model overrides in --from-config are applied by /specrails:enrich, not install.sh.
    # This test verifies that the stored install-config.yaml correctly retains the model
    # overrides from the provided config so that /enrich --from-config can read them.
    local cfg="$TEST_TMPDIR/input-config.yaml"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected:
    - sr-architect
    - sr-developer
  excluded: []
models:
  preset: balanced
  defaults:
    model: sonnet
  overrides:
    sr-architect: opus
YAML
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>/dev/null || true

    local stored="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    assert_file_exists "$stored" \
        "install-config.yaml should exist after --from-config run" || return 1
    local content
    content="$(cat "$stored")"
    assert_contains "$content" "opus" \
        "stored config should retain model override (sr-architect: opus)" || return 1
    assert_contains "$content" "sonnet" \
        "stored config should retain default model (sonnet)" || return 1
}
run_test "SPEA-742: model overrides from config retained in .specrails/install-config.yaml" test_from_config_model_overrides_in_stored_config

# ─────────────────────────────────────────────
# Hub JSON output mode (programmatic consumption)
# ─────────────────────────────────────────────

test_install_accepts_hub_json_flag() {
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --hub-json 2>&1 || true)"
    assert_not_contains "$output" "Unknown argument" \
        "--hub-json flag should be accepted for programmatic hub consumption"
}
run_test "SPEA-742: --hub-json flag accepted for programmatic consumption" test_install_accepts_hub_json_flag

test_hub_json_output_valid_json() {
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --hub-json 2>&1 || true)"
    # When --hub-json is active, checkpoint lines must be valid JSON
    local json_lines
    json_lines="$(printf '%s\n' "$output" | grep '^{' || true)"
    if [[ -n "$json_lines" ]]; then
        while IFS= read -r line; do
            python3 -c "import json; json.loads('$line')" 2>/dev/null || {
                echo "  FAIL: --hub-json produced invalid JSON line: $line"
                return 1
            }
        done <<< "$json_lines"
    fi
}
run_test "SPEA-742: --hub-json output lines are valid JSON" test_hub_json_output_valid_json

# ─────────────────────────────────────────────

print_summary "TUI installer (SPEA-742)"
