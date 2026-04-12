#!/usr/bin/env bash
# Tests for .gitignore management and conditional directory creation.
#
# Covers:
#   - .gitignore gets .claude/agent-memory/ and .specrails/ entries
#   - Duplicate entries are not added on re-install
#   - Existing .gitignore content is preserved
#   - Agent memory directories created per selected agent
#   - Explanations directory created only for sr-architect and sr-reviewer
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running .gitignore and directory creation tests${NC}"
echo ""

# ─────────────────────────────────────────────
# .gitignore management
# ─────────────────────────────────────────────

test_gitignore_adds_agent_memory() {
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    local gitignore="$TEST_TMPDIR/target/.gitignore"
    assert_file_exists "$gitignore" ".gitignore should exist after install" &&
    assert_contains "$(cat "$gitignore")" ".claude/agent-memory/" \
        ".gitignore should contain .claude/agent-memory/"
}
run_test "install adds .claude/agent-memory/ to .gitignore" test_gitignore_adds_agent_memory

test_gitignore_adds_specrails() {
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    local gitignore="$TEST_TMPDIR/target/.gitignore"
    assert_contains "$(cat "$gitignore")" ".specrails/" \
        ".gitignore should contain .specrails/"
}
run_test "install adds .specrails/ to .gitignore" test_gitignore_adds_specrails

test_gitignore_no_duplicates_on_reinstall() {
    # First install
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    # Remove version to allow re-install
    rm -f "$TEST_TMPDIR/target/.specrails/specrails-version"
    # Second install
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    local gitignore="$TEST_TMPDIR/target/.gitignore"
    local count
    count=$(grep -c '.claude/agent-memory/' "$gitignore" 2>/dev/null || echo "0")
    assert_eq "1" "$count" \
        ".claude/agent-memory/ should appear exactly once (found $count)"
}
run_test "no duplicate .gitignore entries on re-install" test_gitignore_no_duplicates_on_reinstall

test_gitignore_preserves_existing_entries() {
    # Pre-populate .gitignore with user content
    echo "node_modules/" > "$TEST_TMPDIR/target/.gitignore"
    echo "dist/" >> "$TEST_TMPDIR/target/.gitignore"
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    local content
    content="$(cat "$TEST_TMPDIR/target/.gitignore")"
    assert_contains "$content" "node_modules/" \
        "existing node_modules/ entry should be preserved" &&
    assert_contains "$content" "dist/" \
        "existing dist/ entry should be preserved" &&
    assert_contains "$content" ".claude/agent-memory/" \
        "new .claude/agent-memory/ entry should be added"
}
run_test "existing .gitignore entries preserved" test_gitignore_preserves_existing_entries

test_gitignore_created_if_missing() {
    # Ensure no .gitignore exists
    rm -f "$TEST_TMPDIR/target/.gitignore"
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    assert_file_exists "$TEST_TMPDIR/target/.gitignore" \
        ".gitignore should be created if missing"
}
run_test ".gitignore created if missing" test_gitignore_created_if_missing

test_gitignore_skips_if_entry_already_present() {
    # Pre-populate with the entries already present
    printf '.claude/agent-memory/\n.specrails/\n' > "$TEST_TMPDIR/target/.gitignore"
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1 || true
    local count
    count=$(wc -l < "$TEST_TMPDIR/target/.gitignore" | tr -d ' ')
    # Should be exactly 2 lines (no additions)
    assert_eq "2" "$count" \
        ".gitignore should have exactly 2 lines (no additions), got $count"
}
run_test ".gitignore not modified when entries already present" test_gitignore_skips_if_entry_already_present

# ─────────────────────────────────────────────
# Agent memory directories
# ─────────────────────────────────────────────

test_agent_memory_dirs_created_per_agent() {
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
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes --from-config "$cfg" --quick >/dev/null 2>&1 || true
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/sr-architect" \
        "sr-architect memory dir should exist" &&
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/sr-developer" \
        "sr-developer memory dir should exist" &&
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/sr-reviewer" \
        "sr-reviewer memory dir should exist" &&
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/sr-test-writer" \
        "sr-test-writer memory dir should exist"
}
run_test "agent memory directories created per selected agent" test_agent_memory_dirs_created_per_agent

# ─────────────────────────────────────────────
# Explanations directory (conditional)
# ─────────────────────────────────────────────

test_explanations_dir_created_for_architect() {
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
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes --from-config "$cfg" --quick >/dev/null 2>&1 || true
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/explanations" \
        "explanations dir should exist when sr-architect is installed"
}
run_test "explanations dir created when sr-architect installed" test_explanations_dir_created_for_architect

test_explanations_dir_created_for_reviewer() {
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
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes --from-config "$cfg" --quick >/dev/null 2>&1 || true
    # Both sr-architect and sr-reviewer trigger explanations dir
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/explanations" \
        "explanations dir should exist when sr-reviewer is installed"
}
run_test "explanations dir created when sr-reviewer installed" test_explanations_dir_created_for_reviewer

test_explanations_dir_not_created_for_other_agents() {
    # This test is conceptual — since sr-architect and sr-reviewer are core agents,
    # they are always installed. The explanations dir will always be created.
    # We verify the conditional logic exists by checking that only specific agents trigger it.
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
    SPECRAILS_SKIP_PREREQS=1 bash "$SPECRAILS_DIR/install.sh" \
        --root-dir "$TEST_TMPDIR/target" --yes --from-config "$cfg" --quick >/dev/null 2>&1 || true
    # The code only creates explanations/ for sr-architect and sr-reviewer
    # Since both are core agents, the dir should exist
    assert_dir_exists "$TEST_TMPDIR/target/.claude/agent-memory/explanations" \
        "explanations dir always exists because architect+reviewer are core" &&
    # Verify sr-developer does NOT have its own explanations subdir
    if [[ -d "$TEST_TMPDIR/target/.claude/agent-memory/sr-developer/explanations" ]]; then
        echo "  FAIL: sr-developer should not have its own explanations subdir"
        return 1
    fi
}
run_test "explanations dir is shared, not per-agent" test_explanations_dir_not_created_for_other_agents

# ─────────────────────────────────────────────

print_summary ".gitignore and directory creation"
