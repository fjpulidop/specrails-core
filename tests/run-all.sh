#!/bin/bash
# Run all specrails tests
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "═══════════════════════════════════════"
echo "  specrails test suite"
echo "═══════════════════════════════════════"

TOTAL_EXIT=0

bash "$SCRIPT_DIR/test-install.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-update.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-cli.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-codex-compat.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-test-writer-template.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-test-command.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-doctor.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-templates.sh" || TOTAL_EXIT=1
# Phase 5 (SPEA-744): TUI installer + /enrich acceptance criteria.
# These suites define spec-driven acceptance tests for Phases 1-2 (SPEA-742, SPEA-743).
# They will FAIL until the corresponding implementation lands.
bash "$SCRIPT_DIR/test-tui-installer.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-install-config.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-enrich-command.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-agent-selection.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-quick-tier.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-gitignore.sh" || TOTAL_EXIT=1
bash "$SCRIPT_DIR/test-hub-json.sh" || TOTAL_EXIT=1

if [[ "$TOTAL_EXIT" -eq 0 ]]; then
    echo -e "\033[0;32m✓ All test suites passed\033[0m"
else
    echo -e "\033[0;31m✗ Some tests failed\033[0m"
fi

exit "$TOTAL_EXIT"
