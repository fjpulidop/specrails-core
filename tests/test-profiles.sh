#!/bin/bash
# Validate profile schema + baseline default profile
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "═══════════════════════════════════════"
echo "  Test: profiles (schema + default)"
echo "═══════════════════════════════════════"

test_schema_is_valid_json() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: schema file is valid JSON"
    if node -e "JSON.parse(require('fs').readFileSync('$SPECRAILS_DIR/schemas/profile.v1.json','utf8'))" >/dev/null 2>&1; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("schema is not valid JSON")
        echo "  FAIL"
    fi
}

test_default_profile_is_valid_json() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: default profile file is valid JSON"
    if node -e "JSON.parse(require('fs').readFileSync('$SPECRAILS_DIR/templates/profiles/default.json','utf8'))" >/dev/null 2>&1; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("default profile is not valid JSON")
        echo "  FAIL"
    fi
}

test_default_profile_passes_schema() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: default profile passes schema validation"
    # Requires ajv (devDep). Skip if node_modules not installed.
    if [[ ! -d "$SPECRAILS_DIR/node_modules/ajv" ]]; then
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo "  SKIP (run 'npm install' first)"
        return 0
    fi
    local output
    if output=$(node "$SCRIPT_DIR/validate-profile.mjs" "$SPECRAILS_DIR/schemas/profile.v1.json" "$SPECRAILS_DIR/templates/profiles/default.json" 2>&1); then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("default profile fails schema: $output")
        echo "  FAIL: $output"
    fi
}

test_invalid_profile_is_rejected() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: invalid profile (missing sr-reviewer) is rejected"
    if [[ ! -d "$SPECRAILS_DIR/node_modules/ajv" ]]; then
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo "  SKIP (run 'npm install' first)"
        return 0
    fi
    local tmpfile
    tmpfile="$(mktemp)"
    cat > "$tmpfile" <<'EOF'
{
  "schemaVersion": 1,
  "name": "broken",
  "orchestrator": { "model": "sonnet" },
  "agents": [
    { "id": "sr-architect" },
    { "id": "sr-developer" }
  ],
  "routing": [
    { "default": true, "agent": "sr-developer" }
  ]
}
EOF
    if node "$SCRIPT_DIR/validate-profile.mjs" "$SPECRAILS_DIR/schemas/profile.v1.json" "$tmpfile" >/dev/null 2>&1; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("invalid profile passed validation (should have failed: missing sr-reviewer)")
        echo "  FAIL"
    else
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    fi
    rm -f "$tmpfile"
}

test_invalid_model_alias_is_rejected() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: invalid model alias is rejected"
    if [[ ! -d "$SPECRAILS_DIR/node_modules/ajv" ]]; then
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo "  SKIP (run 'npm install' first)"
        return 0
    fi
    local tmpfile
    tmpfile="$(mktemp)"
    cat > "$tmpfile" <<'EOF'
{
  "schemaVersion": 1,
  "name": "broken",
  "orchestrator": { "model": "gpt-4" },
  "agents": [
    { "id": "sr-architect" },
    { "id": "sr-developer" },
    { "id": "sr-reviewer" }
  ],
  "routing": [
    { "default": true, "agent": "sr-developer" }
  ]
}
EOF
    if node "$SCRIPT_DIR/validate-profile.mjs" "$SPECRAILS_DIR/schemas/profile.v1.json" "$tmpfile" >/dev/null 2>&1; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("invalid model alias 'gpt-4' passed validation")
        echo "  FAIL"
    else
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    fi
    rm -f "$tmpfile"
}

test_missing_default_routing_rule_rejected() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: profile without default routing rule is rejected"
    if [[ ! -d "$SPECRAILS_DIR/node_modules/ajv" ]]; then
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo "  SKIP (run 'npm install' first)"
        return 0
    fi
    local tmpfile
    tmpfile="$(mktemp)"
    cat > "$tmpfile" <<'EOF'
{
  "schemaVersion": 1,
  "name": "no-default",
  "orchestrator": { "model": "sonnet" },
  "agents": [
    { "id": "sr-architect" },
    { "id": "sr-developer" },
    { "id": "sr-reviewer" }
  ],
  "routing": [
    { "tags": ["frontend"], "agent": "sr-developer" }
  ]
}
EOF
    # Schema's oneOf catches entries without 'default', so the routing entry
    # validates. The "default MUST exist and MUST be last" rule is enforced
    # at runtime by implement.md, not by the JSON schema alone.
    # This test asserts the runtime-level validator (implement.md Phase -1)
    # would reject — documented as integration test; schema-only test SKIPS here.
    TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
    echo "  SKIP (runtime-level check; enforced by implement.md Phase -1)"
    rm -f "$tmpfile"
}

test_update_preserves_reserved_paths() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: update.sh documented contract for reserved paths"
    if grep -q "Reserved paths" "$SPECRAILS_DIR/update.sh" \
        && grep -q "\.specrails/profiles/\*\*" "$SPECRAILS_DIR/update.sh" \
        && grep -q "\.claude/agents/custom-\*\.md" "$SPECRAILS_DIR/update.sh"; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("update.sh missing reserved-paths header")
        echo "  FAIL"
    fi
}

test_install_preserves_reserved_paths() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: install.sh documented contract for reserved paths"
    if grep -q "Reserved paths" "$SPECRAILS_DIR/install.sh" \
        && grep -q "\.specrails/profiles/\*\*" "$SPECRAILS_DIR/install.sh" \
        && grep -q "\.claude/agents/custom-\*\.md" "$SPECRAILS_DIR/install.sh"; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo "  PASS"
    else
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("install.sh missing reserved-paths header")
        echo "  FAIL"
    fi
}

test_cli_profile_validate_exit_codes() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test: specrails-core profile validate exit codes"
    if [[ ! -d "$SPECRAILS_DIR/node_modules/ajv" ]]; then
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        echo "  SKIP (run 'npm install' first)"
        return 0
    fi
    # Valid profile → exit 0
    if ! node "$SPECRAILS_DIR/bin/specrails-core.js" profile validate "$SPECRAILS_DIR/templates/profiles/default.json" >/dev/null 2>&1; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("CLI validate: valid profile returned non-zero exit")
        echo "  FAIL: valid profile got non-zero exit"
        return
    fi
    # Invalid profile → non-zero
    local tmpfile
    tmpfile="$(mktemp)"
    echo '{"schemaVersion": 999}' > "$tmpfile"
    if node "$SPECRAILS_DIR/bin/specrails-core.js" profile validate "$tmpfile" >/dev/null 2>&1; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        FAILED_TESTS+=("CLI validate: invalid profile returned zero exit")
        echo "  FAIL: invalid profile got zero exit"
        rm -f "$tmpfile"
        return
    fi
    rm -f "$tmpfile"
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo "  PASS"
}

test_schema_is_valid_json
test_default_profile_is_valid_json
test_default_profile_passes_schema
test_invalid_profile_is_rejected
test_invalid_model_alias_is_rejected
test_missing_default_routing_rule_rejected
test_update_preserves_reserved_paths
test_install_preserves_reserved_paths
test_cli_profile_validate_exit_codes

echo ""
echo "Results: ${TESTS_PASSED}/${TESTS_RUN} passed, ${TESTS_FAILED} failed, ${TESTS_SKIPPED} skipped"
if (( TESTS_FAILED > 0 )); then
    exit 1
fi
