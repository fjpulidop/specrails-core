#!/bin/bash
# Tests for update.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running update.sh tests${NC}"
echo ""

# Helper: install specrails into target first
install_to_target() {
    bash "$SPECRAILS_DIR/install.sh" --yes --root-dir "$TEST_TMPDIR/target" >/dev/null 2>&1
}

# Helper: run update with 'n' piped to stdin (declines agent regeneration prompt)
run_update() {
    echo "n" | bash "$SPECRAILS_DIR/update.sh" "$@" 2>&1
}

# ─────────────────────────────────────────────
# Syntax
# ─────────────────────────────────────────────

test_update_syntax() {
    bash -n "$SPECRAILS_DIR/update.sh"
}
run_test "syntax check passes" test_update_syntax

# ─────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────

test_update_unknown_arg() {
    local output
    output="$(bash "$SPECRAILS_DIR/update.sh" --bogus 2>&1 || true)"
    assert_contains "$output" "Unknown argument"
}
run_test "--bogus flag rejected" test_update_unknown_arg

test_update_root_dir_missing_value() {
    local output
    output="$(bash "$SPECRAILS_DIR/update.sh" --root-dir 2>&1 || true)"
    assert_contains "$output" "requires a path"
}
run_test "--root-dir without value rejected" test_update_root_dir_missing_value

test_update_only_invalid() {
    local output
    output="$(bash "$SPECRAILS_DIR/update.sh" --only banana 2>&1 || true)"
    assert_contains "$output" "unknown component"
}
run_test "--only with invalid component rejected" test_update_only_invalid

test_update_force_flag_accepted() {
    install_to_target
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --force)"
    assert_not_contains "$output" "Unknown argument"
}
run_test "--force flag accepted" test_update_force_flag_accepted

# ─────────────────────────────────────────────
# No installation found
# ─────────────────────────────────────────────

test_update_no_install() {
    local output
    output="$(bash "$SPECRAILS_DIR/update.sh" --root-dir "$TEST_TMPDIR/target" 2>&1 || true)"
    assert_contains "$output" "No specrails installation found"
}
run_test "fails gracefully when no installation" test_update_no_install

# ─────────────────────────────────────────────
# Up-to-date detection (content-aware)
# ─────────────────────────────────────────────

test_update_up_to_date() {
    install_to_target
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target")"
    assert_contains "$output" "Already up to date"
}
run_test "detects genuinely up-to-date installation" test_update_up_to_date

test_update_detects_changed_template() {
    install_to_target
    # Corrupt a checksum in the manifest to simulate a template change
    python3 -c "
import json
mf = '$TEST_TMPDIR/target/.specrails/specrails-manifest.json'
data = json.load(open(mf))
for key in data['artifacts']:
    data['artifacts'][key] = 'sha256:0000'
    break
json.dump(data, open(mf, 'w'), indent=2)
"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target")"
    assert_contains "$output" "template content has changed"
}
run_test "detects changed templates via checksum mismatch" test_update_detects_changed_template

test_update_force_bypasses_check() {
    install_to_target
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --force)"
    assert_contains "$output" "Update complete" &&
    assert_not_contains "$output" "Already up to date"
}
run_test "--force bypasses up-to-date check" test_update_force_bypasses_check

# ─────────────────────────────────────────────
# Selective updates (do_core) — use --only core to avoid agent prompt
# ─────────────────────────────────────────────

test_update_core_selective_unchanged() {
    install_to_target
    # First update installs skills (not in install.sh), second should be clean
    run_update --root-dir "$TEST_TMPDIR/target" --only core --force >/dev/null
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    assert_contains "$output" "All core artifacts unchanged"
}
run_test "core reports unchanged after second update" test_update_core_selective_unchanged

test_update_core_detects_new_template() {
    install_to_target
    # Remove an artifact from the manifest to simulate "new template"
    python3 -c "
import json
mf = '$TEST_TMPDIR/target/.specrails/specrails-manifest.json'
data = json.load(open(mf))
keys = [k for k in data['artifacts'] if k.startswith('templates/')]
if keys:
    del data['artifacts'][keys[0]]
json.dump(data, open(mf, 'w'), indent=2)
"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    assert_contains "$output" "New:"
}
run_test "core detects new templates" test_update_core_detects_new_template

test_update_core_detects_changed_template() {
    install_to_target
    # Change a checksum in the manifest
    python3 -c "
import json
mf = '$TEST_TMPDIR/target/.specrails/specrails-manifest.json'
data = json.load(open(mf))
for key in data['artifacts']:
    if key.startswith('templates/'):
        data['artifacts'][key] = 'sha256:aaaa'
        break
json.dump(data, open(mf, 'w'), indent=2)
"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    assert_contains "$output" "Changed:"
}
run_test "core detects changed templates" test_update_core_detects_changed_template

# ─────────────────────────────────────────────
# Manifest + version stamp updated after update
# ─────────────────────────────────────────────

test_update_stamps_version() {
    install_to_target
    run_update --root-dir "$TEST_TMPDIR/target" --only core --force >/dev/null
    local version
    version="$(cat "$TEST_TMPDIR/target/.specrails/specrails-version" | tr -d '[:space:]')"
    local expected
    expected="$(cat "$SPECRAILS_DIR/VERSION" | tr -d '[:space:]')"
    assert_eq "$expected" "$version" "version should be stamped after update"
}
run_test "version stamp updated after update" test_update_stamps_version

test_update_manifest_refreshed() {
    install_to_target
    # Corrupt a checksum, then update
    python3 -c "
import json
mf = '$TEST_TMPDIR/target/.specrails/specrails-manifest.json'
data = json.load(open(mf))
for key in data['artifacts']:
    data['artifacts'][key] = 'sha256:old'
    break
json.dump(data, open(mf, 'w'), indent=2)
"
    run_update --root-dir "$TEST_TMPDIR/target" --only core >/dev/null
    local after
    after="$(cat "$TEST_TMPDIR/target/.specrails/specrails-manifest.json")"
    assert_not_contains "$after" "sha256:old" "manifest should not contain corrupted checksum after update"
}
run_test "manifest regenerated with fresh checksums" test_update_manifest_refreshed

# ─────────────────────────────────────────────
# Component filtering (--only)
# ─────────────────────────────────────────────

test_update_only_core() {
    install_to_target
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    assert_contains "$output" "core" &&
    assert_not_contains "$output" "web manager" &&
    assert_not_contains "$output" "adapted artifacts"
}
run_test "--only core updates only core" test_update_only_core

# ─────────────────────────────────────────────
# Backup + cleanup
# ─────────────────────────────────────────────

test_update_cleans_backup_on_success() {
    install_to_target
    run_update --root-dir "$TEST_TMPDIR/target" --force >/dev/null
    if [[ -d "$TEST_TMPDIR/target/.claude.specrails.backup" ]]; then
        echo -e "  ${RED}FAIL${NC}: backup dir should be cleaned up after successful update"
        return 1
    fi
}
run_test "backup cleaned up after successful update" test_update_cleans_backup_on_success

# ─────────────────────────────────────────────
# sr- prefix migration (do_migrate_sr_prefix)
# ─────────────────────────────────────────────

test_update_migrates_sr_prefix_agents() {
    install_to_target
    local agents_dir="$TEST_TMPDIR/target/.claude/agents"
    # Simulate a legacy installation: place an unprefixed architect.md
    mkdir -p "$agents_dir"
    echo "---" > "$agents_dir/architect.md"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    # architect.md should be renamed to sr-architect.md
    assert_file_exists "$agents_dir/sr-architect.md" &&
    assert_not_contains "$output" "Error"
}
run_test "do_migrate_sr_prefix renames legacy agent files" test_update_migrates_sr_prefix_agents

test_update_migrates_sr_prefix_commands() {
    install_to_target
    local agents_dir="$TEST_TMPDIR/target/.claude/agents"
    local commands_dir="$TEST_TMPDIR/target/.claude/commands"
    # Simulate legacy installation: unprefixed agent + command files
    mkdir -p "$agents_dir" "$commands_dir"
    echo "---" > "$agents_dir/architect.md"
    echo "# implement" > "$commands_dir/implement.md"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    # implement.md should be moved to sr/implement.md
    assert_file_exists "$commands_dir/sr/implement.md" &&
    assert_not_contains "$output" "Error"
}
run_test "do_migrate_sr_prefix moves legacy commands to sr/" test_update_migrates_sr_prefix_commands

test_update_migrate_idempotent() {
    install_to_target
    local agents_dir="$TEST_TMPDIR/target/.claude/agents"
    # Install already has sr-prefixed agents — migration should be a no-op
    mkdir -p "$agents_dir"
    echo "---" > "$agents_dir/sr-architect.md"
    local output
    output="$(run_update --root-dir "$TEST_TMPDIR/target" --only core --force)"
    assert_not_contains "$output" "Error"
}
run_test "do_migrate_sr_prefix is idempotent when sr- prefix already present" test_update_migrate_idempotent

# ─────────────────────────────────────────────
# Migration: old metadata paths → new .specrails/ paths
# ─────────────────────────────────────────────

test_update_migrates_old_metadata_paths() {
    install_to_target
    local target="$TEST_TMPDIR/target"
    # Simulate a legacy installation: place files at the old root paths
    cp "$target/.specrails/specrails-version" "$target/.specrails-version"
    cp "$target/.specrails/specrails-manifest.json" "$target/.specrails-manifest.json"
    # Remove the new-path files so migration is the only source
    rm "$target/.specrails/specrails-version" "$target/.specrails/specrails-manifest.json"
    local output
    output="$(run_update --root-dir "$target" --force)"
    assert_file_exists "$target/.specrails/specrails-version" &&
    assert_file_exists "$target/.specrails/specrails-manifest.json" &&
    assert_not_contains "$output" "Error"
}
run_test "update.sh migrates .specrails-version and .specrails-manifest.json to .specrails/" test_update_migrates_old_metadata_paths

test_update_migrates_old_setup_templates() {
    install_to_target
    local target="$TEST_TMPDIR/target"
    # Simulate a legacy installation: setup-templates at a provider-scoped path
    local old_dir="$target/.claude/setup-templates"
    cp -r "$target/.specrails/setup-templates" "$old_dir"
    rm -rf "$target/.specrails/setup-templates"
    local output
    output="$(run_update --root-dir "$target" --force)"
    assert_dir_exists "$target/.specrails/setup-templates" &&
    assert_not_contains "$output" "Error"
}
run_test "update.sh migrates .claude/setup-templates to .specrails/setup-templates" test_update_migrates_old_setup_templates

# ─────────────────────────────────────────────

print_summary "update.sh"
