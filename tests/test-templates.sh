#!/bin/bash
# Tests for template content validation
# Validates all templates in templates/ have correct structure and content
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running template content validation tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Agent templates (templates/agents/*.md)
# ─────────────────────────────────────────────

EXPECTED_AGENTS=(
    "sr-architect"
    "sr-developer"
    "sr-reviewer"
    "sr-product-manager"
    "sr-product-analyst"
    "sr-test-writer"
    "sr-security-reviewer"
    "sr-performance-reviewer"
    "sr-doc-sync"
    "sr-merge-resolver"
    "sr-frontend-developer"
    "sr-frontend-reviewer"
    "sr-backend-developer"
    "sr-backend-reviewer"
)

test_all_agent_templates_exist() {
    local missing=0
    for agent in "${EXPECTED_AGENTS[@]}"; do
        if [[ ! -f "$SPECRAILS_DIR/templates/agents/$agent.md" ]]; then
            echo "  Missing: templates/agents/$agent.md"
            missing=1
        fi
    done
    return "$missing"
}
run_test "all expected agent templates exist" test_all_agent_templates_exist

test_agent_templates_have_frontmatter() {
    local failed=0
    for agent in "${EXPECTED_AGENTS[@]}"; do
        local file="$SPECRAILS_DIR/templates/agents/$agent.md"
        [[ -f "$file" ]] || continue
        local first_line
        first_line="$(head -1 "$file")"
        if [[ "$first_line" != "---" ]]; then
            echo "  $agent.md: missing YAML frontmatter"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all agent templates have YAML frontmatter" test_agent_templates_have_frontmatter

test_agent_templates_have_name_field() {
    local failed=0
    for agent in "${EXPECTED_AGENTS[@]}"; do
        local file="$SPECRAILS_DIR/templates/agents/$agent.md"
        [[ -f "$file" ]] || continue
        if ! grep -q "^name: $agent" "$file"; then
            echo "  $agent.md: missing or mismatched 'name:' field"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all agent templates have matching name field" test_agent_templates_have_name_field

test_agent_templates_have_description() {
    local failed=0
    for agent in "${EXPECTED_AGENTS[@]}"; do
        local file="$SPECRAILS_DIR/templates/agents/$agent.md"
        [[ -f "$file" ]] || continue
        if ! grep -q "^description:" "$file"; then
            echo "  $agent.md: missing 'description:' field"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all agent templates have description field" test_agent_templates_have_description

test_agent_templates_nonempty_body() {
    local failed=0
    for agent in "${EXPECTED_AGENTS[@]}"; do
        local file="$SPECRAILS_DIR/templates/agents/$agent.md"
        [[ -f "$file" ]] || continue
        # Body is everything after the closing --- of frontmatter
        local body_lines
        body_lines="$(awk '/^---$/{f++; next} f>=2{print}' "$file" | wc -l | tr -d ' ')"
        if [[ "$body_lines" -lt 5 ]]; then
            echo "  $agent.md: body too short ($body_lines lines)"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all agent templates have non-empty body (5+ lines)" test_agent_templates_nonempty_body

# ─────────────────────────────────────────────
# Command templates (templates/commands/**/*.md)
# ─────────────────────────────────────────────

EXPECTED_COMMANDS=(
    "sr/implement"
    "sr/product-backlog"
    "sr/batch-implement"
    "sr/health-check"
    "sr/compat-check"
    "sr/refactor-recommender"
    "sr/update-product-driven-backlog"
    "sr/why"
    "sr/retry"
    "sr/telemetry"
    "test"
)

test_all_command_templates_exist() {
    local missing=0
    for cmd in "${EXPECTED_COMMANDS[@]}"; do
        if [[ ! -f "$SPECRAILS_DIR/templates/commands/$cmd.md" ]]; then
            echo "  Missing: templates/commands/$cmd.md"
            missing=1
        fi
    done
    return "$missing"
}
run_test "all expected command templates exist" test_all_command_templates_exist

test_command_templates_nonempty() {
    local failed=0
    while IFS= read -r -d '' file; do
        local lines
        lines="$(wc -l < "$file" | tr -d ' ')"
        if [[ "$lines" -lt 3 ]]; then
            echo "  $(basename "$file"): too short ($lines lines)"
            failed=1
        fi
    done < <(find "$SPECRAILS_DIR/templates/commands" -type f -name '*.md' -print0)
    return "$failed"
}
run_test "all command templates are non-empty (3+ lines)" test_command_templates_nonempty

test_command_templates_placeholders_wellformed() {
    # Command templates use {{UPPER_SNAKE_CASE}} placeholders filled during /setup.
    # Verify no malformed placeholders (e.g., {{lowercase}}, {{Mixed_Case}}, unclosed {{).
    local malformed
    malformed="$(grep -rP '\{\{(?![A-Z_]+\}\})[^}]*\}\}' "$SPECRAILS_DIR/templates/commands/" 2>/dev/null || true)"
    if [[ -n "$malformed" ]]; then
        echo "  Malformed placeholders in command templates:"
        echo "$malformed" | head -5
        return 1
    fi
}
run_test "command template placeholders are well-formed UPPER_SNAKE_CASE" test_command_templates_placeholders_wellformed

# ─────────────────────────────────────────────
# Skill templates (templates/skills/*/SKILL.md)
# ─────────────────────────────────────────────

EXPECTED_SKILLS=(
    "sr-implement"
    "sr-batch-implement"
    "sr-product-backlog"
    "sr-update-backlog"
    "sr-health-check"
    "sr-compat-check"
    "sr-refactor-recommender"
    "sr-why"
)

test_all_skill_templates_exist() {
    local missing=0
    for skill in "${EXPECTED_SKILLS[@]}"; do
        if [[ ! -f "$SPECRAILS_DIR/templates/skills/$skill/SKILL.md" ]]; then
            echo "  Missing: templates/skills/$skill/SKILL.md"
            missing=1
        fi
    done
    return "$missing"
}
run_test "all expected SKILL.md templates exist" test_all_skill_templates_exist

test_skill_templates_have_frontmatter() {
    local failed=0
    for skill in "${EXPECTED_SKILLS[@]}"; do
        local file="$SPECRAILS_DIR/templates/skills/$skill/SKILL.md"
        [[ -f "$file" ]] || continue
        local first_line
        first_line="$(head -1 "$file")"
        if [[ "$first_line" != "---" ]]; then
            echo "  $skill/SKILL.md: missing YAML frontmatter"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all skill templates have YAML frontmatter" test_skill_templates_have_frontmatter

test_skill_templates_have_name() {
    local failed=0
    for skill in "${EXPECTED_SKILLS[@]}"; do
        local file="$SPECRAILS_DIR/templates/skills/$skill/SKILL.md"
        [[ -f "$file" ]] || continue
        if ! grep -q "^name:" "$file"; then
            echo "  $skill/SKILL.md: missing 'name:' field"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all skill templates have name field" test_skill_templates_have_name

test_skill_templates_have_description() {
    local failed=0
    for skill in "${EXPECTED_SKILLS[@]}"; do
        local file="$SPECRAILS_DIR/templates/skills/$skill/SKILL.md"
        [[ -f "$file" ]] || continue
        if ! grep -q "^description:" "$file"; then
            echo "  $skill/SKILL.md: missing 'description:' field"
            failed=1
        fi
    done
    return "$failed"
}
run_test "all skill templates have description field" test_skill_templates_have_description

# ─────────────────────────────────────────────
# Persona templates
# ─────────────────────────────────────────────

test_persona_template_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/personas/persona.md"
}
run_test "persona template exists" test_persona_template_exists

test_persona_has_placeholders() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/personas/persona.md")"
    assert_contains "$content" "{{" "persona template should have placeholders"
}
run_test "persona template has placeholders" test_persona_has_placeholders

# ─────────────────────────────────────────────
# Rules template
# ─────────────────────────────────────────────

test_rules_template_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/rules/layer.md"
}
run_test "rules template exists" test_rules_template_exists

test_rules_has_placeholders() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/rules/layer.md")"
    assert_contains "$content" "{{" "rules template should have placeholders"
}
run_test "rules template has placeholders" test_rules_has_placeholders

# ─────────────────────────────────────────────
# CLAUDE.md template
# ─────────────────────────────────────────────

test_claude_md_template_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/claude-md/root.md"
}
run_test "CLAUDE.md root template exists" test_claude_md_template_exists

test_claude_md_has_placeholders() {
    local content
    content="$(cat "$SPECRAILS_DIR/templates/claude-md/root.md")"
    assert_contains "$content" "{{" "CLAUDE.md template should have placeholders"
}
run_test "CLAUDE.md template has placeholders" test_claude_md_has_placeholders

# ─────────────────────────────────────────────
# Settings template
# ─────────────────────────────────────────────

test_settings_json_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/settings/settings.json"
}
run_test "settings.json template exists" test_settings_json_exists

test_settings_json_valid() {
    python3 -c "import json; json.load(open('$SPECRAILS_DIR/templates/settings/settings.json'))"
}
run_test "settings.json template is valid JSON" test_settings_json_valid

# ─────────────────────────────────────────────
# Local tickets schema template
# ─────────────────────────────────────────────

test_local_tickets_schema_exists() {
    assert_file_exists "$SPECRAILS_DIR/templates/local-tickets-schema.json"
}
run_test "local-tickets-schema.json template exists" test_local_tickets_schema_exists

test_local_tickets_schema_valid_json() {
    python3 -c "import json; json.load(open('$SPECRAILS_DIR/templates/local-tickets-schema.json'))"
}
run_test "local-tickets-schema.json is valid JSON" test_local_tickets_schema_valid_json

test_local_tickets_schema_required_fields() {
    local schema
    schema="$(python3 -c "import json,sys; d=json.load(open('$SPECRAILS_DIR/templates/local-tickets-schema.json')); fields=['schema_version','revision','last_updated','next_id','tickets']; missing=[f for f in fields if f not in d]; print(','.join(missing))")"
    if [[ -n "$schema" ]]; then
        echo "  Missing required fields: $schema"
        return 1
    fi
}
run_test "local-tickets-schema.json has required top-level fields" test_local_tickets_schema_required_fields

test_local_tickets_schema_revision_is_zero() {
    local revision
    revision="$(python3 -c "import json; d=json.load(open('$SPECRAILS_DIR/templates/local-tickets-schema.json')); print(d.get('revision', 'missing'))")"
    if [[ "$revision" != "0" ]]; then
        echo "  Expected revision=0 in initial schema, got: $revision"
        return 1
    fi
}
run_test "local-tickets-schema.json initial revision is 0" test_local_tickets_schema_revision_is_zero

test_local_tickets_schema_tickets_empty() {
    local tickets
    tickets="$(python3 -c "import json; d=json.load(open('$SPECRAILS_DIR/templates/local-tickets-schema.json')); print(len(d.get('tickets', {})))")"
    if [[ "$tickets" != "0" ]]; then
        echo "  Expected empty tickets map in initial schema, got $tickets entries"
        return 1
    fi
}
run_test "local-tickets-schema.json initial tickets map is empty" test_local_tickets_schema_tickets_empty

# ─────────────────────────────────────────────
# Cross-cutting: no trailing whitespace in templates
# ─────────────────────────────────────────────

test_no_empty_template_files() {
    local empty=0
    while IFS= read -r -d '' file; do
        if [[ ! -s "$file" ]]; then
            echo "  Empty file: $file"
            empty=1
        fi
    done < <(find "$SPECRAILS_DIR/templates" -type f -name '*.md' -not -path '*/node_modules/*' -print0)
    return "$empty"
}
run_test "no empty template files" test_no_empty_template_files

# ─────────────────────────────────────────────

print_summary "template content validation"
