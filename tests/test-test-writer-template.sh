#!/bin/bash
# Tests for sr-test-writer agent template and generated instance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running sr-test-writer template tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Agent template file checks
# ─────────────────────────────────────────────

test_template_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/agents/sr-test-writer.md"
}
run_test "agent template file exists" test_template_exists

test_template_has_name_frontmatter() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "name: sr-test-writer"
}
run_test "agent template has name frontmatter" test_template_has_name_frontmatter

test_template_has_tech_expertise_placeholder() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "{{TECH_EXPERTISE}}"
}
run_test "agent template has TECH_EXPERTISE placeholder" test_template_has_tech_expertise_placeholder

test_template_has_layer_paths_placeholder() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "{{LAYER_CLAUDE_MD_PATHS}}"
}
run_test "agent template has LAYER_CLAUDE_MD_PATHS placeholder" test_template_has_layer_paths_placeholder

test_template_has_memory_path_placeholder() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "{{MEMORY_PATH}}"
}
run_test "agent template has MEMORY_PATH placeholder" test_template_has_memory_path_placeholder

test_template_has_framework_detection_table() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "vitest" &&
    assert_contains "$content" "pytest" &&
    assert_contains "$content" "go.mod"
}
run_test "agent template has framework detection table (vitest, pytest, go.mod)" test_template_has_framework_detection_table

test_template_has_test_writer_status_line() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/agents/sr-test-writer.md")"
    assert_contains "$content" "TEST_WRITER_STATUS:"
}
run_test "agent template has TEST_WRITER_STATUS output marker" test_template_has_test_writer_status_line

# ─────────────────────────────────────────────
# Generated instance checks
# ─────────────────────────────────────────────

test_generated_instance_exists() {
    assert_file_exists "$SPECRAILS_DIR/.claude/agents/sr-test-writer.md"
}
run_test "generated agent instance exists" test_generated_instance_exists

test_generated_instance_no_broken_placeholders() {
    local count
    count="$(grep -c '{{[A-Z_]*}}' "$SPECRAILS_DIR/.claude/agents/sr-test-writer.md" || true)"
    assert_eq "0" "$count" "generated instance should have no unresolved placeholders"
}
run_test "generated instance has no broken placeholders" test_generated_instance_no_broken_placeholders

test_generated_instance_has_memory_path() {
    local content
    content="$(cat "$SPECRAILS_DIR/.claude/agents/sr-test-writer.md")"
    assert_contains "$content" ".claude/agent-memory/"
}
run_test "generated instance has memory path substituted" test_generated_instance_has_memory_path

# ─────────────────────────────────────────────

print_summary "sr-test-writer template tests"
exit "$TESTS_FAILED"
