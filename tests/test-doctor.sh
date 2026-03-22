#!/bin/bash
# Tests for bin/doctor.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

DOCTOR="$SPECRAILS_DIR/bin/doctor.sh"

echo ""
echo -e "${BOLD}Running doctor.sh tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Mock helpers — override PATH to control claude/npm
# ─────────────────────────────────────────────

MOCK_BIN=""

setup_doctor_mocks() {
    MOCK_BIN="$TEST_TMPDIR/mock-bin"
    mkdir -p "$MOCK_BIN"
    # Mock claude binary — returns immediately without hanging
    cat > "$MOCK_BIN/claude" << 'MOCKEOF'
#!/bin/bash
if [[ "${*}" == *"config list"* ]]; then
    echo "api_key=sk-test"
fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/claude"
    # Mock npm
    cat > "$MOCK_BIN/npm" << 'MOCKEOF'
#!/bin/bash
if [[ "$1" == "--version" ]]; then echo "10.0.0"; fi
exit 0
MOCKEOF
    chmod +x "$MOCK_BIN/npm"
}

# Build a PATH with mock-bin first, then system essentials (bash, git, find, etc.)
doctor_path() {
    local sys_bin
    sys_bin="$(dirname "$(command -v bash)")"
    local git_bin
    git_bin="$(dirname "$(command -v git)")"
    local find_bin
    find_bin="$(dirname "$(command -v find)")"
    echo "$MOCK_BIN:$sys_bin:$git_bin:$find_bin:/usr/bin:/bin"
}

run_doctor() {
    local target="$1"
    setup_doctor_mocks
    local fake_home="$TEST_TMPDIR/fakehome-$$-$RANDOM"
    mkdir -p "$fake_home"
    (cd "$target" && HOME="$fake_home" PATH="$(doctor_path)" bash "$DOCTOR" 2>&1) || true
}

# ─────────────────────────────────────────────
# Syntax
# ─────────────────────────────────────────────

test_doctor_syntax() {
    bash -n "$DOCTOR"
}
run_test "syntax check passes" test_doctor_syntax

# ─────────────────────────────────────────────
# Pass/fail counters
# ─────────────────────────────────────────────

test_pass_counter() {
    local target="$TEST_TMPDIR/doctor-test"
    mkdir -p "$target/agents/sr-architect"
    echo "---" > "$target/agents/sr-architect/AGENTS.md"
    echo "# CLAUDE.md" > "$target/CLAUDE.md"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "checks passed"
}
run_test "pass counter shows checks passed" test_pass_counter

test_fail_counter() {
    local target="$TEST_TMPDIR/bare-dir"
    mkdir -p "$target"

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "check(s) failed"
}
run_test "fail counter shows failures" test_fail_counter

# ─────────────────────────────────────────────
# Check 1-2: Claude CLI + auth
# ─────────────────────────────────────────────

test_doctor_claude_found() {
    local target="$TEST_TMPDIR/claude-cli"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "Claude Code CLI: found"
}
run_test "detects Claude CLI when present" test_doctor_claude_found

test_doctor_claude_authenticated() {
    local target="$TEST_TMPDIR/claude-auth"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "Claude: authenticated"
}
run_test "detects Claude authentication" test_doctor_claude_authenticated

# ─────────────────────────────────────────────
# Check 3: Agent files
# ─────────────────────────────────────────────

test_doctor_agents_found() {
    local target="$TEST_TMPDIR/agent-test"
    mkdir -p "$target/agents/sr-architect"
    echo "---" > "$target/agents/sr-architect/AGENTS.md"
    git -C "$target" init -q
    echo "# CLAUDE.md" > "$target/CLAUDE.md"

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "agent(s) found"
}
run_test "detects agent files when present" test_doctor_agents_found

test_doctor_agents_missing() {
    local target="$TEST_TMPDIR/no-agents"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "agents/ directory not found"
}
run_test "reports missing agents directory" test_doctor_agents_missing

test_doctor_agents_empty() {
    local target="$TEST_TMPDIR/empty-agents"
    mkdir -p "$target/agents"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "no AGENTS.md found"
}
run_test "reports empty agents directory" test_doctor_agents_empty

# ─────────────────────────────────────────────
# Check 4: CLAUDE.md
# ─────────────────────────────────────────────

test_doctor_claude_md_present() {
    local target="$TEST_TMPDIR/claude-md-test"
    mkdir -p "$target"
    echo "# CLAUDE.md" > "$target/CLAUDE.md"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "CLAUDE.md: present"
}
run_test "detects CLAUDE.md when present" test_doctor_claude_md_present

test_doctor_claude_md_missing() {
    local target="$TEST_TMPDIR/no-claude-md"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "CLAUDE.md: missing"
}
run_test "reports missing CLAUDE.md" test_doctor_claude_md_missing

# ─────────────────────────────────────────────
# Check 5: Git
# ─────────────────────────────────────────────

test_doctor_git_initialized() {
    local target="$TEST_TMPDIR/git-test"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "Git: initialized"
}
run_test "detects git when initialized" test_doctor_git_initialized

test_doctor_git_missing() {
    local target="$TEST_TMPDIR/no-git"
    mkdir -p "$target"

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "not a git repository"
}
run_test "reports missing git" test_doctor_git_missing

# ─────────────────────────────────────────────
# Check 6: npm
# ─────────────────────────────────────────────

test_doctor_npm_found() {
    local target="$TEST_TMPDIR/npm-test"
    mkdir -p "$target"
    git -C "$target" init -q

    local output
    output="$(run_doctor "$target")"
    assert_contains "$output" "npm: found"
}
run_test "detects npm when present" test_doctor_npm_found

# ─────────────────────────────────────────────
# Exit code
# ─────────────────────────────────────────────

test_doctor_exit_zero_all_pass() {
    local target="$TEST_TMPDIR/exit-test"
    mkdir -p "$target/agents/sr-architect"
    echo "---" > "$target/agents/sr-architect/AGENTS.md"
    echo "# CLAUDE.md" > "$target/CLAUDE.md"
    git -C "$target" init -q

    setup_doctor_mocks
    local exit_code=0
    (cd "$target" && PATH="$(doctor_path)" bash "$DOCTOR" >/dev/null 2>&1) || exit_code=$?
    assert_eq "0" "$exit_code" "doctor should exit 0 when all checks pass"
}
run_test "exits 0 when all checks pass" test_doctor_exit_zero_all_pass

test_doctor_exit_one_on_failure() {
    local target="$TEST_TMPDIR/fail-exit"
    mkdir -p "$target"

    setup_doctor_mocks
    local exit_code=0
    (cd "$target" && PATH="$(doctor_path)" bash "$DOCTOR" >/dev/null 2>&1) || exit_code=$?
    assert_eq "1" "$exit_code" "doctor should exit 1 when checks fail"
}
run_test "exits 1 when checks fail" test_doctor_exit_one_on_failure

# ─────────────────────────────────────────────
# Log file
# ─────────────────────────────────────────────

test_doctor_writes_log() {
    local target="$TEST_TMPDIR/log-test"
    mkdir -p "$target"
    git -C "$target" init -q

    setup_doctor_mocks
    local fake_home="$TEST_TMPDIR/fakehome-log"
    mkdir -p "$fake_home"

    (cd "$target" && HOME="$fake_home" PATH="$(doctor_path)" bash "$DOCTOR" >/dev/null 2>&1) || true
    assert_file_exists "$fake_home/.specrails/doctor.log"
}
run_test "writes to doctor.log" test_doctor_writes_log

test_doctor_log_contains_counts() {
    local target="$TEST_TMPDIR/log-content"
    mkdir -p "$target"
    git -C "$target" init -q

    setup_doctor_mocks
    local fake_home="$TEST_TMPDIR/fakehome-log2"
    mkdir -p "$fake_home"

    (cd "$target" && HOME="$fake_home" PATH="$(doctor_path)" bash "$DOCTOR" >/dev/null 2>&1) || true
    local log_content
    log_content="$(cat "$fake_home/.specrails/doctor.log")"
    assert_contains "$log_content" "checks=" &&
    assert_contains "$log_content" "passed=" &&
    assert_contains "$log_content" "failed="
}
run_test "log contains check counts" test_doctor_log_contains_counts

# ─────────────────────────────────────────────

print_summary "doctor.sh"
