#!/bin/bash
# Shared test helpers for install.sh and update.sh tests

set -euo pipefail

SPECRAILS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_TMPDIR=""
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0
FAILED_TESTS=()

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

# ─────────────────────────────────────────────
# Setup / teardown
# ─────────────────────────────────────────────

setup_test_env() {
    TEST_TMPDIR="$(mktemp -d)"
    # Create a fake target repo
    mkdir -p "$TEST_TMPDIR/target"
    git -C "$TEST_TMPDIR/target" init -q
    # Bypass hard-exit prereq checks (Claude CLI / API key) in install.sh during tests
    export SPECRAILS_SKIP_PREREQS=1
}

teardown_test_env() {
    if [[ -n "$TEST_TMPDIR" && -d "$TEST_TMPDIR" ]]; then
        rm -rf "$TEST_TMPDIR"
    fi
}

# ─────────────────────────────────────────────
# Assertions
# ─────────────────────────────────────────────

assert_eq() {
    local expected="$1"
    local actual="$2"
    local msg="${3:-"expected '$expected', got '$actual'"}"
    if [[ "$expected" != "$actual" ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        return 1
    fi
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="${3:-"output should contain '$needle'"}"
    if [[ "$haystack" != *"$needle"* ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        echo "  Output was: ${haystack:0:200}"
        return 1
    fi
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="${3:-"output should NOT contain '$needle'"}"
    if [[ "$haystack" == *"$needle"* ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        return 1
    fi
}

assert_file_exists() {
    local filepath="$1"
    local msg="${2:-"file should exist: $filepath"}"
    if [[ ! -f "$filepath" ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        return 1
    fi
}

assert_dir_exists() {
    local dirpath="$1"
    local msg="${2:-"directory should exist: $dirpath"}"
    if [[ ! -d "$dirpath" ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        return 1
    fi
}

assert_exit_code() {
    local expected="$1"
    local actual="$2"
    local msg="${3:-"expected exit code $expected, got $actual"}"
    if [[ "$expected" != "$actual" ]]; then
        echo -e "  ${RED}FAIL${NC}: $msg"
        return 1
    fi
}

# ─────────────────────────────────────────────
# Test runner
# ─────────────────────────────────────────────

run_test() {
    local test_name="$1"
    local test_fn="$2"
    ((TESTS_RUN++))

    setup_test_env

    echo -n "  $test_name ... "
    if $test_fn; then
        echo -e "${GREEN}PASS${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}FAIL${NC}"
        ((TESTS_FAILED++))
        FAILED_TESTS+=("$test_name")
    fi

    teardown_test_env
}

print_summary() {
    local suite_name="$1"
    echo ""
    echo -e "${BOLD}─── $suite_name ───${NC}"
    echo -e "  Total: $TESTS_RUN  ${GREEN}Passed: $TESTS_PASSED${NC}  ${RED}Failed: $TESTS_FAILED${NC}"
    if [[ ${#FAILED_TESTS[@]} -gt 0 ]]; then
        echo ""
        echo -e "  ${RED}Failed tests:${NC}"
        for t in "${FAILED_TESTS[@]}"; do
            echo "    - $t"
        done
    fi
    echo ""
    return "$TESTS_FAILED"
}
