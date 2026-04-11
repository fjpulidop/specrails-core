#!/usr/bin/env bash
# Tests for /specrails:enrich command template and integration contract v3.
#
# These tests define the acceptance criteria for SPEA-743 (Phase 2: /enrich command).
# They will FAIL on the baseline (before implementation) and PASS when Phase 2 is done.
# That is intentional — spec-driven approach.
#
# Covers:
#   - templates/commands/specrails/enrich.md exists
#   - Enrich template contains --from-config mode
#   - Enrich template has checkpoint markers for hub integration
#   - integration-contract.json v3 schema (tiers, configSchema fields)
#   - CLI: node bin/specrails-core.js registers 'enrich' subcommand
#   - agents.yaml generated during install (SPEA-738 foundation)
#
# Related tasks:
#   SPEA-743: Phase 2 — /specrails:enrich + --from-config mode + Codex support
#   SPEA-744: Phase 5 — Tests (this file)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running /specrails:enrich command tests${NC}"
echo ""

NODE="$(command -v node)"
CLI="$SPECRAILS_DIR/bin/specrails-core.js"

# ─────────────────────────────────────────────
# Template existence
# ─────────────────────────────────────────────

test_enrich_template_exists() {
    assert_file_exists \
        "$SPECRAILS_DIR/templates/commands/specrails/enrich.md" \
        "templates/commands/specrails/enrich.md must exist (Phase 2)"
}
run_test "SPEA-743: templates/commands/specrails/enrich.md exists" test_enrich_template_exists

test_enrich_template_not_empty() {
    local template="$SPECRAILS_DIR/templates/commands/specrails/enrich.md"
    if [[ ! -f "$template" ]]; then
        echo "  SKIP: enrich.md does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$template")"
    [[ -n "$content" ]] || { echo "  FAIL: enrich.md is empty"; return 1; }
}
run_test "SPEA-743: enrich.md template is non-empty" test_enrich_template_not_empty

test_enrich_template_staged_on_install() {
    # After install, enrich command should be in setup-templates for /setup to deploy
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes 2>/dev/null || true
    assert_file_exists \
        "$TEST_TMPDIR/target/.specrails/setup-templates/commands/specrails/enrich.md" \
        "enrich.md should be staged in .specrails/setup-templates after install"
}
run_test "SPEA-743: enrich.md staged in setup-templates on install" test_enrich_template_staged_on_install

# ─────────────────────────────────────────────
# Template content: --from-config mode
# ─────────────────────────────────────────────

test_enrich_template_documents_from_config() {
    local template="$SPECRAILS_DIR/templates/commands/specrails/enrich.md"
    if [[ ! -f "$template" ]]; then
        echo "  SKIP: enrich.md does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$template")"
    assert_contains "$content" "from-config" \
        "enrich.md should document the --from-config flag"
}
run_test "SPEA-743: enrich.md documents --from-config flag" test_enrich_template_documents_from_config

test_enrich_template_references_install_config() {
    local template="$SPECRAILS_DIR/templates/commands/specrails/enrich.md"
    if [[ ! -f "$template" ]]; then
        echo "  SKIP: enrich.md does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$template")"
    assert_contains "$content" "install-config.yaml" \
        "enrich.md should reference install-config.yaml"
}
run_test "SPEA-743: enrich.md references install-config.yaml" test_enrich_template_references_install_config

test_enrich_template_has_checkpoint_markers() {
    # Hub integration requires enrich to emit checkpoint markers
    # so the hub can track progress in CheckpointTracker
    local template="$SPECRAILS_DIR/templates/commands/specrails/enrich.md"
    if [[ ! -f "$template" ]]; then
        echo "  SKIP: enrich.md does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$template")"
    assert_contains "$content" "checkpoint" \
        "enrich.md should reference checkpoints for hub integration"
}
run_test "SPEA-743: enrich.md documents checkpoint protocol for hub" test_enrich_template_has_checkpoint_markers

test_enrich_template_supports_codex() {
    # Phase 2 adds Codex support — enrich must mention codex/\$enrich path
    local template="$SPECRAILS_DIR/templates/commands/specrails/enrich.md"
    if [[ ! -f "$template" ]]; then
        echo "  SKIP: enrich.md does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$template")"
    assert_contains "$content" "codex" \
        "enrich.md should document Codex support"
}
run_test "SPEA-743: enrich.md documents Codex support (\$enrich skill)" test_enrich_template_supports_codex

# ─────────────────────────────────────────────
# CLI: enrich subcommand
# ─────────────────────────────────────────────

test_cli_registers_enrich_command() {
    local output
    output="$("$NODE" "$CLI" 2>&1 || true)"
    assert_contains "$output" "enrich" \
        "node CLI usage should list 'enrich' as an available command"
}
run_test "SPEA-743: node CLI usage lists 'enrich' as available command" test_cli_registers_enrich_command

test_cli_enrich_unknown_flag_rejected() {
    local output
    output="$("$NODE" "$CLI" enrich --bogus-flag 2>&1 || true)"
    assert_contains "$output" "Unknown flag" \
        "enrich: unknown flags should be rejected"
}
run_test "SPEA-743: CLI enrich rejects unknown flags" test_cli_enrich_unknown_flag_rejected

test_cli_enrich_from_config_flag_accepted() {
    local cfg="$TEST_TMPDIR/enrich-config.yaml"
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
    output="$("$NODE" "$CLI" enrich --from-config "$cfg" 2>&1 || true)"
    assert_not_contains "$output" "Unknown flag" \
        "enrich --from-config should be in the CLI allowlist"
}
run_test "SPEA-743: CLI enrich --from-config not rejected as unknown flag" test_cli_enrich_from_config_flag_accepted

# ─────────────────────────────────────────────
# Integration contract v3 (Phase 3 blocker)
# ─────────────────────────────────────────────

test_integration_contract_exists() {
    assert_file_exists \
        "$SPECRAILS_DIR/templates/settings/integration-contract.json" \
        "templates/settings/integration-contract.json must exist (Phase 3)"
}
run_test "SPEA-743: integration-contract.json template exists" test_integration_contract_exists

test_integration_contract_valid_json() {
    local contract="$SPECRAILS_DIR/templates/settings/integration-contract.json"
    if [[ ! -f "$contract" ]]; then
        echo "  SKIP: integration-contract.json does not exist yet"
        return 0
    fi
    python3 -c "import json; json.load(open('$contract'))" 2>/dev/null || {
        echo "  FAIL: integration-contract.json is not valid JSON"
        return 1
    }
}
run_test "SPEA-743: integration-contract.json is valid JSON" test_integration_contract_valid_json

test_integration_contract_v3_has_tiers() {
    local contract="$SPECRAILS_DIR/templates/settings/integration-contract.json"
    if [[ ! -f "$contract" ]]; then
        echo "  SKIP: integration-contract.json does not exist yet"
        return 0
    fi
    python3 - << PYEOF
import json, sys
c = json.load(open('$contract'))
if 'tiers' not in c:
    print("  FAIL: integration-contract.json missing 'tiers' field (v3 requirement)")
    sys.exit(1)
PYEOF
}
run_test "SPEA-743: integration-contract.json v3 has 'tiers' field" test_integration_contract_v3_has_tiers

test_integration_contract_v3_has_config_schema() {
    local contract="$SPECRAILS_DIR/templates/settings/integration-contract.json"
    if [[ ! -f "$contract" ]]; then
        echo "  SKIP: integration-contract.json does not exist yet"
        return 0
    fi
    python3 - << PYEOF
import json, sys
c = json.load(open('$contract'))
if 'configSchema' not in c:
    print("  FAIL: integration-contract.json missing 'configSchema' field (v3 requirement)")
    sys.exit(1)
PYEOF
}
run_test "SPEA-743: integration-contract.json v3 has 'configSchema' field" test_integration_contract_v3_has_config_schema

test_integration_contract_v3_enrich_command() {
    local contract="$SPECRAILS_DIR/templates/settings/integration-contract.json"
    if [[ ! -f "$contract" ]]; then
        echo "  SKIP: integration-contract.json does not exist yet"
        return 0
    fi
    local content
    content="$(cat "$contract")"
    assert_contains "$content" "enrich" \
        "integration-contract.json should reference the /enrich command"
}
run_test "SPEA-743: integration-contract.json references /specrails:enrich command" test_integration_contract_v3_enrich_command

test_integration_contract_staged_on_install() {
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes 2>/dev/null || true

    # Contract should be available for hub to read
    local contract="$TEST_TMPDIR/target/.specrails/setup-templates/settings/integration-contract.json"
    if [[ ! -f "$SPECRAILS_DIR/templates/settings/integration-contract.json" ]]; then
        echo "  SKIP: integration-contract.json template does not exist yet"
        return 0
    fi
    assert_file_exists "$contract" \
        "integration-contract.json should be staged in .specrails/setup-templates"
}
run_test "SPEA-743: integration-contract.json staged in setup-templates on install" test_integration_contract_staged_on_install

# ─────────────────────────────────────────────
# agents.yaml foundation (SPEA-738, already landed)
# These tests validate that the agents.yaml config infrastructure
# from SPEA-738 is intact and compatible with the install-config schema.
# ─────────────────────────────────────────────

test_agents_yaml_template_in_setup_command() {
    # /specrails:setup should generate .specrails/agents.yaml (SPEA-738)
    local setup_cmd="$SPECRAILS_DIR/templates/commands/specrails/setup.md"
    assert_file_exists "$setup_cmd" \
        "templates/commands/specrails/setup.md should exist"
    local content
    content="$(cat "$setup_cmd")"
    assert_contains "$content" "agents.yaml" \
        "setup.md should reference agents.yaml generation"
}
run_test "SPEA-738: setup.md references agents.yaml generation" test_agents_yaml_template_in_setup_command

test_reconfig_command_exists() {
    assert_file_exists \
        "$SPECRAILS_DIR/templates/commands/specrails/reconfig.md" \
        "templates/commands/specrails/reconfig.md should exist (SPEA-738)"
}
run_test "SPEA-738: reconfig.md command template exists" test_reconfig_command_exists

test_reconfig_staged_on_install() {
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes 2>/dev/null || true
    assert_file_exists \
        "$TEST_TMPDIR/target/.specrails/setup-templates/commands/specrails/reconfig.md" \
        "reconfig.md should be staged in .specrails/setup-templates"
}
run_test "SPEA-738: reconfig.md staged in setup-templates on install" test_reconfig_staged_on_install

# ─────────────────────────────────────────────

print_summary "/specrails:enrich command (SPEA-743)"
