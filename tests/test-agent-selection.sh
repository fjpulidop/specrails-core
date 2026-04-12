#!/usr/bin/env bash
# Tests for core agent enforcement and agent filtering via --from-config.
#
# Covers:
#   - Core agents (sr-architect, sr-developer, sr-reviewer, sr-merge-resolver)
#     are never removed by --from-config filtering
#   - Non-core agents ARE removed when excluded from agents.selected
#   - Model preset application to agent frontmatter
#   - Model overrides take precedence over defaults
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running agent selection and filtering tests${NC}"
echo ""

# Helper: run a quick install with a given config and return the target dir
_install_with_config() {
    local cfg_file="$1"
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg_file" --quick >/dev/null 2>&1 || true
    echo "$target"
}

# ─────────────────────────────────────────────
# Core agents enforcement
# ─────────────────────────────────────────────

test_core_agents_never_removed_when_excluded() {
    # Config tries to select only sr-test-writer — core agents must survive
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-test-writer]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local target
    target="$(_install_with_config "$cfg")"
    assert_file_exists "$target/.specrails/setup-templates/agents/sr-architect.md" \
        "sr-architect must survive filtering (core agent)" &&
    assert_file_exists "$target/.specrails/setup-templates/agents/sr-developer.md" \
        "sr-developer must survive filtering (core agent)" &&
    assert_file_exists "$target/.specrails/setup-templates/agents/sr-reviewer.md" \
        "sr-reviewer must survive filtering (core agent)" &&
    assert_file_exists "$target/.specrails/setup-templates/agents/sr-merge-resolver.md" \
        "sr-merge-resolver must survive filtering (core agent)"
}
run_test "core agents never removed by --from-config filtering" test_core_agents_never_removed_when_excluded

test_core_agents_deployed_in_quick_tier() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
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
    local target
    target="$(_install_with_config "$cfg")"
    # Quick tier places agents directly in .claude/agents/
    assert_file_exists "$target/.claude/agents/sr-architect.md" \
        "sr-architect deployed to .claude/agents/" &&
    assert_file_exists "$target/.claude/agents/sr-developer.md" \
        "sr-developer deployed to .claude/agents/" &&
    assert_file_exists "$target/.claude/agents/sr-reviewer.md" \
        "sr-reviewer deployed to .claude/agents/" &&
    assert_file_exists "$target/.claude/agents/sr-merge-resolver.md" \
        "sr-merge-resolver deployed to .claude/agents/"
}
run_test "core agents deployed to final location in quick tier" test_core_agents_deployed_in_quick_tier

# ─────────────────────────────────────────────
# Non-core agent filtering
# ─────────────────────────────────────────────

test_non_core_agent_removed_when_not_selected() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
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
    local target
    target="$(_install_with_config "$cfg")"
    # sr-test-writer not in selected list → should be removed from setup-templates
    if [[ -f "$target/.specrails/setup-templates/agents/sr-test-writer.md" ]]; then
        echo "  FAIL: sr-test-writer should have been removed from setup-templates"
        return 1
    fi
}
run_test "non-core agent removed when not in agents.selected" test_non_core_agent_removed_when_not_selected

test_non_core_agent_kept_when_selected() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver, sr-test-writer]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local target
    target="$(_install_with_config "$cfg")"
    assert_file_exists "$target/.specrails/setup-templates/agents/sr-test-writer.md" \
        "sr-test-writer should remain when explicitly selected"
}
run_test "non-core agent kept when explicitly selected" test_non_core_agent_kept_when_selected

test_multiple_agents_filtered() {
    # Select only core + sr-test-writer; everything else should be removed
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver, sr-test-writer]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides: {}
YAML
    local target
    target="$(_install_with_config "$cfg")"
    local remaining
    remaining=$(ls "$target/.specrails/setup-templates/agents/"*.md 2>/dev/null | wc -l | tr -d ' ')
    # Should have exactly 5: 4 core + sr-test-writer
    assert_eq "5" "$remaining" \
        "should have 5 agents (4 core + sr-test-writer), got $remaining"
}
run_test "multiple non-selected agents removed, selected preserved" test_multiple_agents_filtered

test_filtering_message_in_output() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
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
    local target="$TEST_TMPDIR/target"
    mkdir -p "$target"
    git -C "$target" init -q 2>/dev/null || true
    local output
    output="$(SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$target" --yes --from-config "$cfg" --quick 2>&1 || true)"
    assert_contains "$output" "filtered" \
        "output should mention agent filtering when agents were removed"
}
run_test "install output mentions filtering when agents removed" test_filtering_message_in_output

# ─────────────────────────────────────────────
# Model preset application
# ─────────────────────────────────────────────

test_model_preset_balanced_applies_sonnet() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
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
    local target
    target="$(_install_with_config "$cfg")"
    local model_line
    model_line="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-developer.md" | head -1)"
    assert_contains "$model_line" "sonnet" \
        "balanced preset should set model: sonnet in agent templates"
}
run_test "balanced preset applies sonnet model to agents" test_model_preset_balanced_applies_sonnet

test_model_preset_budget_applies_haiku() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
models:
  preset: budget
  defaults: { model: haiku }
  overrides: {}
YAML
    local target
    target="$(_install_with_config "$cfg")"
    local model_line
    model_line="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-developer.md" | head -1)"
    assert_contains "$model_line" "haiku" \
        "budget preset should set model: haiku in agent templates"
}
run_test "budget preset applies haiku model to agents" test_model_preset_budget_applies_haiku

test_model_preset_max_applies_opus() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
models:
  preset: max
  defaults: { model: opus }
  overrides: {}
YAML
    local target
    target="$(_install_with_config "$cfg")"
    local model_line
    model_line="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-developer.md" | head -1)"
    assert_contains "$model_line" "opus" \
        "max preset should set model: opus in agent templates"
}
run_test "max preset applies opus model to agents" test_model_preset_max_applies_opus

# ─────────────────────────────────────────────
# Model overrides
# ─────────────────────────────────────────────

test_model_override_takes_precedence() {
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides:
    sr-architect: opus
YAML
    local target
    target="$(_install_with_config "$cfg")"
    local architect_model
    architect_model="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-architect.md" | head -1)"
    local developer_model
    developer_model="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-developer.md" | head -1)"
    assert_contains "$architect_model" "opus" \
        "sr-architect should use override model (opus)" &&
    assert_contains "$developer_model" "sonnet" \
        "sr-developer should use default model (sonnet)"
}
run_test "model override takes precedence over default" test_model_override_takes_precedence

test_block_model_override_format() {
    # Block-style overrides (indented key-value pairs under overrides:)
    local cfg="$TEST_TMPDIR/cfg.yaml"
    cat > "$cfg" <<'YAML'
version: 1
provider: claude
tier: quick
agents:
  selected: [sr-architect, sr-developer, sr-reviewer, sr-merge-resolver]
models:
  preset: balanced
  defaults: { model: sonnet }
  overrides:
    sr-architect: opus
    sr-reviewer: haiku
YAML
    local target
    target="$(_install_with_config "$cfg")"
    local architect_model
    architect_model="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-architect.md" | head -1)"
    local reviewer_model
    reviewer_model="$(grep '^model:' "$target/.specrails/setup-templates/agents/sr-reviewer.md" | head -1)"
    assert_contains "$architect_model" "opus" \
        "block override for sr-architect should apply opus" &&
    assert_contains "$reviewer_model" "haiku" \
        "block override for sr-reviewer should apply haiku"
}
run_test "block override format applies per-agent models" test_block_model_override_format

# ─────────────────────────────────────────────

print_summary "Agent selection and filtering"
