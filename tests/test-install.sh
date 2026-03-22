#!/bin/bash
# Tests for install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running install.sh tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Syntax
# ─────────────────────────────────────────────

test_install_syntax() {
    bash -n "$SPECRAILS_DIR/install.sh"
}
run_test "syntax check passes" test_install_syntax

# ─────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────

test_install_unknown_arg() {
    local output
    output="$(bash "$SPECRAILS_DIR/install.sh" --bogus 2>&1 || true)"
    assert_contains "$output" "Unknown argument"
}
run_test "--bogus flag rejected" test_install_unknown_arg

test_install_root_dir_missing_value() {
    local output
    output="$(bash "$SPECRAILS_DIR/install.sh" --root-dir 2>&1 || true)"
    assert_contains "$output" "requires a path"
}
run_test "--root-dir without value rejected" test_install_root_dir_missing_value

# ─────────────────────────────────────────────
# Fresh install into target repo
# ─────────────────────────────────────────────

test_install_fresh() {
    local output
    output="$(echo "y" | bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" 2>&1)"
    assert_contains "$output" "Installation complete" &&
    assert_file_exists "$TEST_TMPDIR/target/.specrails-version" &&
    assert_file_exists "$TEST_TMPDIR/target/.specrails-manifest.json" &&
    # Provider-agnostic: check whichever provider dir was created (.claude/commands or .agents/skills)
    { assert_dir_exists "$TEST_TMPDIR/target/.claude/commands" ||
      assert_dir_exists "$TEST_TMPDIR/target/.agents/skills"; } &&
    { assert_dir_exists "$TEST_TMPDIR/target/.claude/setup-templates" ||
      assert_dir_exists "$TEST_TMPDIR/target/.codex/setup-templates"; }
}
run_test "fresh install creates expected structure" test_install_fresh

test_install_creates_version_file() {
    echo "y" | bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1
    local version
    version="$(cat "$TEST_TMPDIR/target/.specrails-version" | tr -d '[:space:]')"
    local expected
    expected="$(cat "$SPECRAILS_DIR/VERSION" | tr -d '[:space:]')"
    assert_eq "$expected" "$version" "version file should match VERSION"
}
run_test "version file matches VERSION" test_install_creates_version_file

test_install_manifest_valid_json() {
    echo "y" | bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1
    python3 -c "import json; json.load(open('$TEST_TMPDIR/target/.specrails-manifest.json'))"
}
run_test "manifest is valid JSON" test_install_manifest_valid_json

# ─────────────────────────────────────────────
# Double install (should warn)
# ─────────────────────────────────────────────

test_install_double() {
    echo "y" | bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1
    local output
    output="$(echo "y" | bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" 2>&1 || true)"
    assert_contains "$output" "already"
}
run_test "double install warns about existing installation" test_install_double

# ─────────────────────────────────────────────
# Non-git directory (pipe 'n' to decline interactive prompt)
# ─────────────────────────────────────────────

test_install_source_repo_detection() {
    # Running install.sh from within specrails source should detect it
    # and warn about source repo (since SCRIPT_DIR == REPO_ROOT area)
    local output
    output="$(echo "q" | bash "$SPECRAILS_DIR/install.sh" 2>&1 || true)"
    assert_contains "$output" "specrails source repo"
}
run_test "detects running from specrails source repo" test_install_source_repo_detection

# ─────────────────────────────────────────────
# Auth check: OAuth detection
# ─────────────────────────────────────────────

test_auth_oauth_accepted() {
    local fake_home
    fake_home="$(mktemp -d)"

    # Create ~/.claude.json with oauthAccount (simulates Claude Pro/Max OAuth login)
    echo '{"oauthAccount": {"accountUuid": "test-uuid", "emailAddress": "test@example.com"}}' \
        > "$fake_home/.claude.json"

    # Stub claude binary: present but returns no api_key (OAuth-only setup)
    mkdir -p "$fake_home/bin"
    printf '#!/bin/bash\nif [[ "$*" == *"config list"* ]]; then echo ""; fi\n' \
        > "$fake_home/bin/claude"
    chmod +x "$fake_home/bin/claude"

    local target="$TEST_TMPDIR/oauth-target"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(echo "y" | HOME="$fake_home" PATH="$fake_home/bin:$PATH" SPECRAILS_SKIP_PREREQS=0 ANTHROPIC_API_KEY="" \
        bash "$SPECRAILS_DIR/install.sh" --root-dir "$target" 2>&1 || true)"

    rm -rf "$fake_home"

    assert_not_contains "$output" "No Claude authentication found" &&
    assert_contains "$output" "Claude: authenticated"
}
run_test "OAuth session accepted as valid authentication" test_auth_oauth_accepted

test_auth_error_mentions_both_options() {
    local fake_home
    fake_home="$(mktemp -d)"

    # Stub claude binary with no api_key and no OAuth session
    mkdir -p "$fake_home/bin"
    printf '#!/bin/bash\nif [[ "$*" == *"config list"* ]]; then echo ""; fi\n' \
        > "$fake_home/bin/claude"
    chmod +x "$fake_home/bin/claude"

    local target="$TEST_TMPDIR/noauth-target"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(HOME="$fake_home" PATH="$fake_home/bin:$PATH" SPECRAILS_SKIP_PREREQS=0 ANTHROPIC_API_KEY="" \
        bash "$SPECRAILS_DIR/install.sh" --root-dir "$target" --provider claude 2>&1 || true)"

    rm -rf "$fake_home"

    assert_contains "$output" "claude auth login"
}
run_test "unauthenticated error message mentions both auth options" test_auth_error_mentions_both_options

# ─────────────────────────────────────────────

print_summary "install.sh"
