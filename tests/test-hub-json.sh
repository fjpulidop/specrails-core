#!/usr/bin/env bash
# Tests for --hub-json checkpoint output mode.
#
# Covers:
#   - --hub-json flag accepted
#   - Checkpoint lines emitted during installation
#   - Checkpoint lines contain expected markers
#   - Quick tier emits quick_placement checkpoint
#   - Hub JSON does not break normal installation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running --hub-json checkpoint output tests${NC}"
echo ""

# Helper: run install with --hub-json and capture output
_hub_install() {
    local cfg_file="$1"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg_file" --quick --hub-json 2>&1
}

_write_base_config() {
    local cfg="$1"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
}

# ─────────────────────────────────────────────
# Basic flag acceptance
# ─────────────────────────────────────────────

test_hub_json_flag_accepted() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local output
    output="$(_hub_install "$cfg")"
    assert_not_contains "$output" "Unknown argument" \
        "--hub-json should be accepted without error"
}
run_test "--hub-json flag accepted" test_hub_json_flag_accepted

# ─────────────────────────────────────────────
# Checkpoint output
# ─────────────────────────────────────────────

test_hub_json_emits_checkpoint() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local output
    output="$(_hub_install "$cfg")"
    assert_contains "$output" "CHECKPOINT:" \
        "--hub-json should emit CHECKPOINT: lines"
}
run_test "--hub-json emits checkpoint lines" test_hub_json_emits_checkpoint

test_hub_json_quick_placement_checkpoint() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local output
    output="$(_hub_install "$cfg")"
    assert_contains "$output" "CHECKPOINT:quick_placement:done" \
        "--hub-json quick tier should emit quick_placement:done checkpoint"
}
run_test "--hub-json emits quick_placement:done checkpoint" test_hub_json_quick_placement_checkpoint

# ─────────────────────────────────────────────
# Does not break normal installation
# ─────────────────────────────────────────────

test_hub_json_still_installs_agents() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg" --quick --hub-json >/dev/null 2>&1 || true
    assert_file_exists "$target/.claude/agents/sr-architect.md" \
        "agents should still be installed with --hub-json"
}
run_test "--hub-json does not prevent agent installation" test_hub_json_still_installs_agents

test_hub_json_still_creates_manifest() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg" --quick --hub-json >/dev/null 2>&1 || true
    assert_file_exists "$target/.specrails/specrails-manifest.json" \
        "manifest should still be created with --hub-json"
}
run_test "--hub-json does not prevent manifest creation" test_hub_json_still_creates_manifest

test_hub_json_still_creates_version() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg" --quick --hub-json >/dev/null 2>&1 || true
    assert_file_exists "$target/.specrails/specrails-version" \
        "version file should still be created with --hub-json"
}
run_test "--hub-json does not prevent version file creation" test_hub_json_still_creates_version

# ─────────────────────────────────────────────
# Without --hub-json (no checkpoint lines)
# ─────────────────────────────────────────────

test_no_hub_json_no_checkpoints() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    _write_base_config "$cfg"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg" --quick 2>&1 || true)"
    assert_not_contains "$output" "CHECKPOINT:" \
        "without --hub-json, no CHECKPOINT: lines should appear"
}
run_test "without --hub-json, no checkpoint lines emitted" test_no_hub_json_no_checkpoints

# ─────────────────────────────────────────────

print_summary "--hub-json checkpoint output"
