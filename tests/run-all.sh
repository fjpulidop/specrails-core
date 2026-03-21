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

if [[ "$TOTAL_EXIT" -eq 0 ]]; then
    echo -e "\033[0;32m✓ All test suites passed\033[0m"
else
    echo -e "\033[0;31m✗ Some tests failed\033[0m"
fi

exit "$TOTAL_EXIT"
