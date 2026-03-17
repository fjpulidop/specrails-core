#!/bin/bash
# Tests for /sr:test command template and its installed copy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running test command template tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Command template file checks
# ─────────────────────────────────────────────

test_template_command_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/commands/test.md"
}
run_test "command template file exists" test_template_command_exists

test_template_has_name_key() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "name:"
}
run_test "command template has name key" test_template_has_name_key

test_template_has_description_key() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "description:"
}
run_test "command template has description key" test_template_has_description_key

test_template_has_phases_key() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "phases:"
}
run_test "command template has phases key" test_template_has_phases_key

test_template_has_detect_phase() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "key: detect"
}
run_test "command template has detect phase" test_template_has_detect_phase

test_template_has_write_phase() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "key: write"
}
run_test "command template has write phase" test_template_has_write_phase

test_template_has_report_phase() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "key: report"
}
run_test "command template has report phase" test_template_has_report_phase

test_template_references_sr_test_writer() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/commands/test.md")"
    assert_contains "$content" "sr-test-writer"
}
run_test "command template references sr-test-writer agent" test_template_references_sr_test_writer

test_template_no_broken_placeholders() {
    local count
    count="$(grep -c '{{[A-Z_]*}}' "$SPECRAILS_DIR/templates/commands/test.md" || true)"
    assert_eq "0" "$count" "command template should have no unresolved placeholders"
}
run_test "command template has no broken placeholders" test_template_no_broken_placeholders

# ─────────────────────────────────────────────
# Installed copy checks
# ─────────────────────────────────────────────

test_installed_command_exists() {
    assert_file_exists "$SPECRAILS_DIR/.claude/commands/sr/test.md"
}
run_test "installed command file exists" test_installed_command_exists

test_installed_matches_template() {
    diff "$SPECRAILS_DIR/templates/commands/test.md" "$SPECRAILS_DIR/.claude/commands/sr/test.md"
}
run_test "installed command is identical to template" test_installed_matches_template

# ─────────────────────────────────────────────

print_summary "test command template tests"
exit "$TESTS_FAILED"
