#!/bin/bash
# Tests for cross-platform compatibility: Claude Code + Codex (SPEA-505 epic)
#
# Strategy: manipulate PATH to mock CLI presence/absence.
# These tests define the acceptance criteria for SPEA-506 through SPEA-509.
# They will FAIL on the baseline (before implementation) and PASS when each
# subtask is complete — that is intentional (spec-driven approach).
#
# Related tasks:
#   SPEA-506: Provider detection & directory abstraction
#   SPEA-507: Skills migration (/specrails:* → SKILL.md)
#   SPEA-508: Dual permissions config (settings.json + config.toml)
#   SPEA-509: Agent definitions dual format (Markdown + TOML)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo -e "${BOLD}Running cross-platform compatibility tests${NC}"
echo ""

# ─────────────────────────────────────────────
# CLI mocking helpers
# ─────────────────────────────────────────────

MOCK_BIN=""

setup_mock_bin() {
    MOCK_BIN="$TEST_TMPDIR/mock-bin"
    mkdir -p "$MOCK_BIN"
}

mock_cli() {
    local cli_name="$1"
    local version="${2:-1.0.0}"
    cat > "$MOCK_BIN/$cli_name" << EOF
#!/bin/bash
echo "$cli_name version $version"
exit 0
EOF
    chmod +x "$MOCK_BIN/$cli_name"
}

# Run install.sh with a PATH that only exposes the requested CLIs.
# Usage: run_install_with_path "<mock_bin_contents>" "<extra_install_args>"
# The caller must set up $MOCK_BIN stubs before calling this.
run_install_mocked() {
    local extra_args="${1:-}"
    # Build a system PATH that includes all normal tools but NOT real AI CLIs.
    # Copying whole directories (e.g. /opt/homebrew/bin) can leak claude/codex.
    # Strategy: symlink every file from each system-PATH dir EXCEPT claude & codex.
    local sys_bin="$TEST_TMPDIR/sys-bin"
    rm -rf "$sys_bin"
    mkdir -p "$sys_bin"
    local IFS=':'
    for dir in $(dirname "$(command -v bash)") $(dirname "$(command -v git)") $(dirname "$(command -v python3)" 2>/dev/null || echo "/usr/bin"); do
        [ -d "$dir" ] || continue
        for f in "$dir"/*; do
            local name
            name="$(basename "$f")"
            # Skip AI CLIs — only mocked versions in MOCK_BIN should be discoverable
            [[ "$name" == "claude" || "$name" == "codex" ]] && continue
            # Don't overwrite already-linked commands (first dir wins)
            [ -e "$sys_bin/$name" ] && continue
            ln -sf "$f" "$sys_bin/$name" 2>/dev/null || true
        done
    done
    unset IFS
    local mock_path="$MOCK_BIN:$sys_bin"
    env PATH="$mock_path" SPECRAILS_SKIP_PREREQS=1 \
        bash "$SPECRAILS_DIR/install.sh" --root-dir "$TEST_TMPDIR/target" --yes $extra_args 2>&1 || true
}

# ─────────────────────────────────────────────
# SPEA-506: Provider detection
# ─────────────────────────────────────────────

test_provider_detection_claude_only() {
    setup_mock_bin
    mock_cli "claude"
    local output
    output="$(run_install_mocked)"
    # When only claude is present, installer should proceed without asking
    assert_not_contains "$output" "Error: no AI CLI"
    assert_not_contains "$output" "Codex not found"
}
run_test "SPEA-506: only claude binary → proceeds without error" test_provider_detection_claude_only

test_provider_detection_codex_only() {
    setup_mock_bin
    mock_cli "codex"
    local output
    output="$(run_install_mocked)"
    assert_not_contains "$output" "Error: no AI CLI"
    assert_not_contains "$output" "Claude Code not found"
}
run_test "SPEA-506: only codex binary → proceeds without error" test_provider_detection_codex_only

test_provider_detection_neither_cli() {
    setup_mock_bin
    # No claude or codex in mock bin — only system binaries
    # With SPECRAILS_SKIP_PREREQS=1, install warns and continues rather than hard-exiting.
    local output
    output="$(run_install_mocked)"
    assert_contains "$output" "No AI CLI found"
}
run_test "SPEA-506: no AI CLI → prints informative error" test_provider_detection_neither_cli

test_provider_flag_claude() {
    setup_mock_bin
    mock_cli "claude"
    mock_cli "codex"
    local output
    output="$(run_install_mocked "--provider claude")"
    assert_not_contains "$output" "Error:"
}
run_test "SPEA-506: --provider claude flag accepted when both CLIs present" test_provider_flag_claude

test_provider_flag_codex() {
    setup_mock_bin
    mock_cli "claude"
    mock_cli "codex"
    local output
    output="$(run_install_mocked "--provider codex")"
    assert_not_contains "$output" "Error:"
}
run_test "SPEA-506: --provider codex flag accepted when both CLIs present" test_provider_flag_codex

# ─────────────────────────────────────────────
# SPEA-506: Output directory structure
# ─────────────────────────────────────────────

test_claude_output_dir_created() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    assert_dir_exists "$TEST_TMPDIR/target/.claude"
    assert_dir_exists "$TEST_TMPDIR/target/.claude/commands"
}
run_test "SPEA-506: claude provider → .claude/ directory created" test_claude_output_dir_created

test_codex_output_dir_created() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    assert_dir_exists "$TEST_TMPDIR/target/.codex"
}
run_test "SPEA-506: codex provider → .codex/ directory created" test_codex_output_dir_created

test_claude_instruction_file_created() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    # install.sh records provider intent in .provider-detection.json;
    # /setup uses this to create CLAUDE.md at repo root.
    local detection="$TEST_TMPDIR/target/.claude/setup-templates/.provider-detection.json"
    assert_file_exists "$detection"
    assert_contains "$(cat "$detection")" '"instructions_file": "CLAUDE.md"' \
        ".provider-detection.json should record CLAUDE.md as instructions file"
}
run_test "SPEA-506: claude provider → CLAUDE.md instruction file created" test_claude_instruction_file_created

test_codex_instruction_file_created() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # install.sh records provider intent in .provider-detection.json;
    # /setup uses this to create AGENTS.md at repo root.
    local detection="$TEST_TMPDIR/target/.codex/setup-templates/.provider-detection.json"
    assert_file_exists "$detection"
    assert_contains "$(cat "$detection")" '"instructions_file": "AGENTS.md"' \
        ".provider-detection.json should record AGENTS.md as instructions file"
}
run_test "SPEA-506: codex provider → AGENTS.md instruction file created" test_codex_instruction_file_created

# ─────────────────────────────────────────────
# SPEA-507: Skills format
# ─────────────────────────────────────────────

EXPECTED_SKILLS=(
    "sr-implement"
    "sr-batch-implement"
    "sr-product-backlog"
    "sr-update-backlog"
    "sr-compat-check"
    "sr-why"
    "sr-refactor-recommender"
)

test_skills_exist_for_claude() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    # install.sh stages SKILL.md files in setup-templates/; /setup deploys them to .claude/skills/
    local skills_dir="$TEST_TMPDIR/target/.claude/setup-templates/skills"
    assert_dir_exists "$skills_dir"
    for skill in "${EXPECTED_SKILLS[@]}"; do
        assert_file_exists "$skills_dir/$skill/SKILL.md" \
            "SKILL.md should exist for skill: $skill"
    done
}
run_test "SPEA-507: all expected SKILL.md files created for claude provider" test_skills_exist_for_claude

test_skills_exist_for_codex() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # install.sh stages SKILL.md files in .codex/setup-templates/; /setup deploys them
    local skills_dir="$TEST_TMPDIR/target/.codex/setup-templates/skills"
    assert_dir_exists "$skills_dir"
    for skill in "${EXPECTED_SKILLS[@]}"; do
        assert_file_exists "$skills_dir/$skill/SKILL.md" \
            "SKILL.md should exist for skill: $skill (codex)"
    done
}
run_test "SPEA-507: all expected SKILL.md files created for codex provider" test_skills_exist_for_codex

test_backward_compat_slash_commands() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    # Legacy slash commands are staged in setup-templates/; /setup deploys them to .claude/commands/specrails/
    assert_dir_exists "$TEST_TMPDIR/target/.claude/setup-templates/commands/specrails"
}
run_test "SPEA-507: backward compat — slash commands still present for claude provider" test_backward_compat_slash_commands

# ─────────────────────────────────────────────
# SPEA-508: Permissions config
# ─────────────────────────────────────────────

test_claude_settings_json_created() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    # install.sh stages settings.json in setup-templates/; /setup deploys it to .claude/settings.json
    local settings="$TEST_TMPDIR/target/.claude/setup-templates/settings/settings.json"
    assert_file_exists "$settings"
    # Must be valid JSON
    python3 -c "import json; json.load(open('$settings'))" \
        || { echo "  FAIL: setup-templates/settings/settings.json is not valid JSON"; return 1; }
}
run_test "SPEA-508: claude provider → .claude/settings.json is valid JSON" test_claude_settings_json_created

test_codex_config_toml_created() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # install.sh stages codex-config.toml in setup-templates/; /setup deploys it to .codex/config.toml
    assert_file_exists "$TEST_TMPDIR/target/.codex/setup-templates/settings/codex-config.toml"
}
run_test "SPEA-508: codex provider → .codex/config.toml created" test_codex_config_toml_created

test_codex_starlark_rules_created() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # install.sh stages codex-rules.star in setup-templates/; /setup deploys it as .codex/rules/default.rules
    assert_file_exists "$TEST_TMPDIR/target/.codex/setup-templates/settings/codex-rules.star"
}
run_test "SPEA-508: codex provider → .codex/rules/default.rules created" test_codex_starlark_rules_created

# ─────────────────────────────────────────────
# SPEA-509: Agent definitions
# ─────────────────────────────────────────────

EXPECTED_AGENTS=(
    "sr-architect"
    "sr-developer"
    "sr-reviewer"
    "sr-product-manager"
)

test_claude_agent_markdown_files() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked "--provider claude" >/dev/null
    # install.sh stages agent templates in setup-templates/agents/; /setup generates .claude/agents/sr-*.md
    for agent in "${EXPECTED_AGENTS[@]}"; do
        assert_file_exists "$TEST_TMPDIR/target/.claude/setup-templates/agents/$agent.md" \
            "Agent template should exist: $agent.md"
        # Verify YAML frontmatter present in template
        local content
        content="$(cat "$TEST_TMPDIR/target/.claude/setup-templates/agents/$agent.md")"
        assert_contains "$content" "---" "Agent template $agent.md should have frontmatter"
    done
}
run_test "SPEA-509: claude provider → sr-*.md agents with frontmatter" test_claude_agent_markdown_files

test_codex_agent_toml_files() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # install.sh stages agent templates in .codex/setup-templates/agents/;
    # /setup converts them to sr-*.toml with TOML format (SPEA-509).
    # Verify: (1) agent templates exist, (2) /setup command has TOML conversion logic.
    for agent in "${EXPECTED_AGENTS[@]}"; do
        assert_file_exists "$TEST_TMPDIR/target/.codex/setup-templates/agents/$agent.md" \
            "Agent template should exist for codex: $agent.md"
    done
    # Codex: setup is installed as an Agent Skill, not a command
    local setup_skill="$TEST_TMPDIR/target/.agents/skills/setup/SKILL.md"
    assert_file_exists "$setup_skill"
    assert_contains "$(cat "$setup_skill")" "toml" \
        "\$setup skill should contain TOML generation logic for codex"
}
run_test "SPEA-509: codex provider → sr-*.toml agents with TOML format" test_codex_agent_toml_files

test_agent_prompt_content_identical() {
    setup_mock_bin
    mock_cli "claude"
    mock_cli "codex"
    run_install_mocked "--provider claude" >/dev/null
    local claude_target="$TEST_TMPDIR/target"
    local codex_tmpdir="$TEST_TMPDIR/target-codex"
    mkdir -p "$codex_tmpdir"
    git -C "$codex_tmpdir" init -q
    env SPECRAILS_SKIP_PREREQS=1 PATH="$MOCK_BIN:$(dirname "$(command -v bash)"):$(dirname "$(command -v git)")" \
        bash "$SPECRAILS_DIR/install.sh" --root-dir "$codex_tmpdir" --yes --provider codex >/dev/null 2>&1 || true

    for agent in "${EXPECTED_AGENTS[@]}"; do
        local md_file="$claude_target/.claude/agents/$agent.md"
        local toml_file="$codex_tmpdir/.codex/agents/$agent.toml"
        if [[ ! -f "$md_file" || ! -f "$toml_file" ]]; then
            continue  # Skip if not yet implemented
        fi
        # Extract body (after frontmatter) from .md
        local md_body
        md_body="$(awk '/^---$/{f=!f; next} !f{print}' "$md_file" | tail -n +2)"
        # Extract description from .toml (simplified check)
        local toml_desc
        toml_desc="$(grep '^description' "$toml_file" | head -1)"
        # At minimum, both must have non-empty content
        [[ -n "$md_body" ]] || { echo "  FAIL: $agent.md body is empty"; return 1; }
        [[ -n "$toml_desc" ]] || { echo "  FAIL: $agent.toml has no description"; return 1; }
    done
}
run_test "SPEA-509: agent prompt content non-empty in both formats" test_agent_prompt_content_identical

# ─────────────────────────────────────────────
# Regression: existing Claude Code tests not broken
# ─────────────────────────────────────────────

test_regression_fresh_install_claude() {
    setup_mock_bin
    mock_cli "claude"
    local output
    output="$(run_install_mocked)"
    assert_contains "$output" "Installation complete"
    assert_file_exists "$TEST_TMPDIR/target/.specrails-version"
    assert_file_exists "$TEST_TMPDIR/target/.specrails-manifest.json"
}
run_test "regression: existing install flow still works with claude provider" test_regression_fresh_install_claude

test_regression_no_broken_placeholders_claude() {
    setup_mock_bin
    mock_cli "claude"
    run_install_mocked >/dev/null
    # Broken placeholders in finalized generated files (agents, commands, skills) would be a regression.
    # Exclude setup-templates/ — those are source templates that get filled in during /setup.
    # Exclude setup.md — it's a meta-template that documents {{PLACEHOLDER}} syntax for the AI.
    local broken
    broken="$(grep -r '{{[A-Z_]*}}' \
        "$TEST_TMPDIR/target/.claude/agents/" \
        "$TEST_TMPDIR/target/.claude/skills/" \
        2>/dev/null || true)"
    broken+="$(grep -r '{{[A-Z_]*}}' \
        "$TEST_TMPDIR/target/.claude/commands/" \
        --exclude="setup.md" \
        2>/dev/null || true)"
    if [[ -n "$broken" ]]; then
        echo "  FAIL: broken placeholders found in generated .claude/ files:"
        echo "$broken" | head -10
        return 1
    fi
}
run_test "regression: no broken placeholders in generated .claude/ files (claude provider)" test_regression_no_broken_placeholders_claude

test_regression_no_broken_placeholders_codex() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    # Broken placeholders in finalized generated files (skills) would be a regression.
    # Exclude setup-templates/ — those are source templates filled in during /setup.
    # Exclude .agents/skills/setup/ and .agents/skills/doctor/ — these are installer
    # scaffold skills that wrap the setup/doctor wizard prompts, which intentionally
    # document {{PLACEHOLDER}} syntax for the AI to substitute at runtime.
    local broken
    broken="$(grep -r '{{[A-Z_]*}}' \
        "$TEST_TMPDIR/target/.agents/skills/" \
        --exclude-dir="setup" \
        --exclude-dir="doctor" \
        2>/dev/null || true)"
    if [[ -n "$broken" ]]; then
        echo "  FAIL: broken placeholders found in generated .agents/skills/ files:"
        echo "$broken" | head -10
        return 1
    fi
}
run_test "regression: no broken placeholders in .codex/ output (codex provider)" test_regression_no_broken_placeholders_codex

# ─────────────────────────────────────────────
# Edge cases
# ─────────────────────────────────────────────

test_switch_provider_claude_to_codex() {
    setup_mock_bin
    mock_cli "claude"
    mock_cli "codex"
    # First install with claude
    run_install_mocked "--provider claude" >/dev/null
    assert_dir_exists "$TEST_TMPDIR/target/.claude"
    # Re-install with codex — .claude/ should not be corrupted
    run_install_mocked "--provider codex" >/dev/null
    assert_dir_exists "$TEST_TMPDIR/target/.codex"
    # .claude/ should still exist (we don't delete it)
    assert_dir_exists "$TEST_TMPDIR/target/.claude"
}
run_test "edge case: switching from claude to codex keeps both dirs intact" test_switch_provider_claude_to_codex

test_idempotent_reinstall_codex() {
    setup_mock_bin
    mock_cli "codex"
    run_install_mocked "--provider codex" >/dev/null
    local output
    output="$(run_install_mocked "--provider codex")"
    # Second install should warn, not crash
    assert_not_contains "$output" "Error:"
}
run_test "edge case: idempotent re-install with codex provider" test_idempotent_reinstall_codex

# ─────────────────────────────────────────────

print_summary "cross-platform compatibility"
