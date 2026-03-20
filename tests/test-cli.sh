#!/bin/bash
# Tests for bin/specrails-core.js — argument validation and injection safety
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

NODE="$(command -v node)"
CLI="$SPECRAILS_DIR/bin/specrails-core.js"

echo ""
echo -e "${BOLD}Running specrails-core.js tests${NC}"
echo ""

# ─────────────────────────────────────────────
# Basic CLI smoke tests
# ─────────────────────────────────────────────

test_cli_no_args() {
    local output
    output="$("$NODE" "$CLI" 2>&1 || true)"
    assert_contains "$output" "specrails-core"
    assert_contains "$output" "Usage:"
}
run_test "no args prints usage" test_cli_no_args

test_cli_unknown_command() {
    local output exit_code
    output="$("$NODE" "$CLI" bogus 2>&1 || true)"
    assert_contains "$output" "Unknown command"
}
run_test "unknown command prints error" test_cli_unknown_command

# ─────────────────────────────────────────────
# Flag allowlist tests
# ─────────────────────────────────────────────

test_cli_init_unknown_flag() {
    local output
    output="$("$NODE" "$CLI" init --bogus-flag 2>&1 || true)"
    assert_contains "$output" "Unknown flag"
}
run_test "init: unknown flag rejected" test_cli_init_unknown_flag

test_cli_update_unknown_flag() {
    local output
    output="$("$NODE" "$CLI" update --bogus-flag 2>&1 || true)"
    assert_contains "$output" "Unknown flag"
}
run_test "update: unknown flag rejected" test_cli_update_unknown_flag

test_cli_doctor_any_flag() {
    local output
    output="$("$NODE" "$CLI" doctor --anything 2>&1 || true)"
    assert_contains "$output" "Unknown flag"
}
run_test "doctor: any flag rejected (no flags allowed)" test_cli_doctor_any_flag

# ─────────────────────────────────────────────
# Command injection safety (HIGH-01 / SPEA-289)
# ─────────────────────────────────────────────

test_cli_injection_does_not_execute() {
    # Attempt to inject a command via shell metacharacters in an argument.
    # With spawnSync (no shell), these are passed as literal argv values to bash,
    # so the injected payload never executes.
    local sentinel="INJECTION_EXECUTED_$$"
    local tmpfile="$TEST_TMPDIR/injection-marker"

    # This would execute `touch $tmpfile` in the old execSync + string concat path.
    local injection="; touch $tmpfile #"

    # Run via spawnSync path — the flag check should reject the arg (starts with semicolon
    # which doesn't start with "-", so it passes the flag check but bash receives it as a
    # literal argument, not as a shell metacharacter sequence).
    # We use a known-bad flag to ensure the CLI exits before calling bash at all,
    # so we test both the flag guard and the non-shell-expansion path.

    # Test 1: metacharacter in a flag value position — flag allowlist catches the flag
    "$NODE" "$CLI" init "--root-dir=/tmp/x; touch $tmpfile" 2>/dev/null || true
    if [[ -f "$tmpfile" ]]; then
        rm -f "$tmpfile"
        echo "  FAIL: injection via flag value executed a command"
        return 1
    fi

    # Test 2: semicolon as a bare arg — passes flag check (no leading -),
    # but spawnSync passes it as a literal bash argument, not a shell command.
    # bash receives it as a positional arg and install.sh will reject it as "Unknown argument".
    "$NODE" "$CLI" init "; touch $tmpfile" 2>/dev/null || true
    if [[ -f "$tmpfile" ]]; then
        rm -f "$tmpfile"
        echo "  FAIL: injection via bare arg executed a command"
        return 1
    fi

    return 0
}
run_test "command injection attempt does not execute injected payload" test_cli_injection_does_not_execute

test_cli_injection_subcommand_unknown_flag() {
    # An attacker using a flag with shell metacharacters should be rejected by
    # the allowlist before the shell script is ever invoked.
    local output
    output="$("$NODE" "$CLI" init '--root-dir=$(id)' 2>&1 || true)"
    # spawnSync passes the value literally to bash, so $(id) is not evaluated.
    # If it somehow ran, bash install.sh would receive the literal string.
    # Either way, the process must not contain command-substitution output.
    assert_not_contains "$output" "uid="
}
run_test "flag value with command substitution is not evaluated" test_cli_injection_subcommand_unknown_flag

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────

print_summary "specrails-core.js"
