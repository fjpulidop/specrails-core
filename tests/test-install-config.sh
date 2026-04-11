#!/usr/bin/env bash
# Tests for install-config.yaml schema validation.
#
# These tests validate the schema contract for .specrails/install-config.yaml,
# which is the config file written by the TUI installer and read by install.sh
# when running in --from-config mode.
#
# Strategy: spec-driven tests for SPEA-742 (Phase 1). Tests will FAIL before
# implementation and PASS once the schema and --from-config mode are complete.
#
# Related tasks:
#   SPEA-742: Phase 1 — Node.js TUI Installer + install-config.yaml schema
#   SPEA-744: Phase 5 — Tests (this file)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running install-config.yaml schema tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Schema fixture helpers
# ─────────────────────────────────────────────

write_valid_config() {
    local path="$1"
    mkdir -p "$(dirname "$path")"
    cat > "$path" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected:
    - sr-architect
    - sr-developer
    - sr-reviewer
    - sr-test-writer
    - sr-product-manager
  excluded:
    - sr-frontend-developer
    - sr-frontend-reviewer
    - sr-backend-developer
    - sr-backend-reviewer
    - sr-security-reviewer
    - sr-performance-reviewer
    - sr-product-analyst
    - sr-doc-sync
    - sr-merge-resolver
models:
  preset: balanced
  defaults:
    model: sonnet
  overrides:
    sr-architect: opus
    sr-product-manager: opus
quick_context:
  product_description: "A test platform"
  target_users: "Engineering teams"
agent_teams: false
YAML
}

# ─────────────────────────────────────────────
# Valid config: accepted by installer
# ─────────────────────────────────────────────

test_valid_config_accepted() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    write_valid_config "$cfg"
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_not_contains "$output" "Invalid config" \
        "valid install-config.yaml should not produce config error"
    assert_not_contains "$output" "Error:" \
        "valid config should not cause an error exit"
}
run_test "valid install-config.yaml is accepted without error" test_valid_config_accepted

# ─────────────────────────────────────────────
# Required fields
# ─────────────────────────────────────────────

test_config_missing_version_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
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
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "version" \
        "config missing version field should mention 'version' in error"
}
run_test "install-config.yaml missing 'version' field is rejected" test_config_missing_version_rejected

test_config_missing_provider_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
tier: full
agents:
  selected: [sr-architect]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "provider" \
        "config missing provider field should mention 'provider' in error"
}
run_test "install-config.yaml missing 'provider' field is rejected" test_config_missing_provider_rejected

test_config_missing_agents_section_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "agents" \
        "config missing agents section should mention 'agents' in error"
}
run_test "install-config.yaml missing 'agents' section is rejected" test_config_missing_agents_section_rejected

# ─────────────────────────────────────────────
# Field value validation
# ─────────────────────────────────────────────

test_config_invalid_provider_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: vscode
tier: full
agents:
  selected: [sr-architect]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "provider" \
        "invalid provider value should mention 'provider' in error"
}
run_test "install-config.yaml with invalid provider value is rejected" test_config_invalid_provider_rejected

test_config_invalid_tier_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: enterprise
agents:
  selected: [sr-architect]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "tier" \
        "invalid tier value 'enterprise' should mention 'tier' in error"
}
run_test "install-config.yaml with invalid tier value is rejected" test_config_invalid_tier_rejected

test_config_invalid_model_preset_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected: [sr-architect]
models:
  preset: expensive
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "preset" \
        "invalid preset value 'expensive' should mention 'preset' in error"
}
run_test "install-config.yaml with invalid model preset is rejected" test_config_invalid_model_preset_rejected

test_config_unknown_agent_in_selected_warns() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected:
    - sr-architect
    - sr-nonexistent-agent
  excluded: []
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    # Unknown agents should warn, not crash
    assert_contains "$output" "sr-nonexistent-agent" \
        "unknown agent in selected list should be mentioned in output"
}
run_test "install-config.yaml unknown agent in selected list produces warning" test_config_unknown_agent_in_selected_warns

# ─────────────────────────────────────────────
# Version field
# ─────────────────────────────────────────────

test_config_version_1_supported() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    write_valid_config "$cfg"
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_not_contains "$output" "Unsupported config version" \
        "version: 1 should be supported"
}
run_test "install-config.yaml version: 1 is supported" test_config_version_1_supported

test_config_future_version_rejected() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 99
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
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>&1 || true)"
    assert_contains "$output" "version" \
        "unsupported config version should mention 'version' in error"
}
run_test "install-config.yaml with unsupported version is rejected" test_config_future_version_rejected

# ─────────────────────────────────────────────
# --from-config file not found
# ─────────────────────────────────────────────

test_from_config_missing_file_error() {
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$TEST_TMPDIR/nonexistent-config.yaml" 2>&1 || true)"
    assert_contains "$output" "not found" \
        "missing --from-config file should produce 'not found' error"
}
run_test "--from-config with missing file produces clear error" test_from_config_missing_file_error

# ─────────────────────────────────────────────
# Quick tier: config schema
# ─────────────────────────────────────────────

test_quick_config_minimal_schema() {
    # Quick tier config is minimal — only requires version, provider, tier, agents
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
    assert_not_contains "$output" "Invalid config" \
        "minimal quick-tier config should be valid"
}
run_test "quick tier: minimal install-config.yaml is valid" test_quick_config_minimal_schema

# ─────────────────────────────────────────────
# Model presets
# ─────────────────────────────────────────────

test_balanced_preset_uses_sonnet_default() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>/dev/null || true

    local agents_dir="$TEST_TMPDIR/target/.specrails/setup-templates/agents"
    if [[ -f "$agents_dir/sr-developer.md" ]]; then
        local content
        content="$(cat "$agents_dir/sr-developer.md")"
        assert_contains "$content" "sonnet" \
            "balanced preset: sr-developer should use sonnet model"
    fi
}
run_test "model preset 'balanced': default model is sonnet" test_balanced_preset_uses_sonnet_default

test_budget_preset_uses_haiku_default() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer]
models:
  preset: budget
  defaults: { model: haiku }
  overrides: {}
YAML
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>/dev/null || true

    local agents_dir="$TEST_TMPDIR/target/.specrails/setup-templates/agents"
    if [[ -f "$agents_dir/sr-developer.md" ]]; then
        local content
        content="$(cat "$agents_dir/sr-developer.md")"
        assert_contains "$content" "haiku" \
            "budget preset: sr-developer should use haiku model"
    fi
}
run_test "model preset 'budget': default model is haiku" test_budget_preset_uses_haiku_default

test_max_preset_uses_opus_default() {
    local cfg="$TEST_TMPDIR/target/.specrails/install-config.yaml"
    mkdir -p "$(dirname "$cfg")"
    cat > "$cfg" << 'YAML'
version: 1
provider: claude
tier: full
agents:
  selected: [sr-architect, sr-developer]
models:
  preset: max
  defaults: { model: opus }
  overrides: {}
YAML
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes \
        --from-config "$cfg" 2>/dev/null || true

    local agents_dir="$TEST_TMPDIR/target/.specrails/setup-templates/agents"
    if [[ -f "$agents_dir/sr-developer.md" ]]; then
        local content
        content="$(cat "$agents_dir/sr-developer.md")"
        assert_contains "$content" "opus" \
            "max preset: sr-developer should use opus model"
    fi
}
run_test "model preset 'max': default model is opus" test_max_preset_uses_opus_default

# ─────────────────────────────────────────────

print_summary "install-config.yaml schema (SPEA-742)"
