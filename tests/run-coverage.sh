#!/bin/bash
# Run test suite with kcov coverage collection
# Usage: bash tests/run-coverage.sh
#
# Requires: kcov (https://github.com/SimonKagworki/kcov)
#   macOS:  brew install kcov
#   Ubuntu: apt-get install kcov
#
# Output: coverage/ directory with HTML report + Cobertura XML

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COVERAGE_DIR="$REPO_DIR/coverage"

# ─────────────────────────────────────────────
# Check kcov availability
# ─────────────────────────────────────────────

if ! command -v kcov &>/dev/null; then
    echo "kcov not found. Install it first:"
    echo "  macOS:  brew install kcov"
    echo "  Ubuntu: apt-get install kcov"
    exit 1
fi

# ─────────────────────────────────────────────
# Clean previous coverage
# ─────────────────────────────────────────────

rm -rf "$COVERAGE_DIR"
mkdir -p "$COVERAGE_DIR"

# ─────────────────────────────────────────────
# Run tests under kcov
# ─────────────────────────────────────────────

echo "═══════════════════════════════════════"
echo "  specrails test suite (with coverage)"
echo "═══════════════════════════════════════"

# Include only project shell scripts, exclude test helpers and node_modules
INCLUDE_PATHS="$REPO_DIR/install.sh,$REPO_DIR/update.sh,$REPO_DIR/bin/doctor.sh,$REPO_DIR/bin/specrails-core.js"
EXCLUDE_PATTERN="/tmp,/var,node_modules,tests/"

kcov \
    --include-path="$INCLUDE_PATHS" \
    --exclude-pattern="$EXCLUDE_PATTERN" \
    "$COVERAGE_DIR" \
    bash "$SCRIPT_DIR/run-all.sh"

EXIT_CODE=$?

# ─────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════"
echo "  Coverage report"
echo "═══════════════════════════════════════"

if [[ -f "$COVERAGE_DIR/run-all.sh/coverage.json" ]]; then
    PERCENT="$(python3 -c "
import json, sys
try:
    data = json.load(open('$COVERAGE_DIR/run-all.sh/coverage.json'))
    print(data.get('percent_covered', 'N/A'))
except Exception:
    print('N/A')
" 2>/dev/null || echo "N/A")"
    echo "  Line coverage: ${PERCENT}%"
    echo "  HTML report:   $COVERAGE_DIR/run-all.sh/index.html"
elif [[ -f "$COVERAGE_DIR/kcov-merged/coverage.json" ]]; then
    PERCENT="$(python3 -c "
import json
data = json.load(open('$COVERAGE_DIR/kcov-merged/coverage.json'))
print(data.get('percent_covered', 'N/A'))
" 2>/dev/null || echo "N/A")"
    echo "  Line coverage: ${PERCENT}%"
    echo "  HTML report:   $COVERAGE_DIR/kcov-merged/index.html"
else
    echo "  Coverage data generated in: $COVERAGE_DIR/"
fi

# ─────────────────────────────────────────────
# Cobertura XML for CI integration
# ─────────────────────────────────────────────

COBERTURA="$(find "$COVERAGE_DIR" -name 'cobertura.xml' -print -quit 2>/dev/null || true)"
if [[ -n "$COBERTURA" ]]; then
    echo "  Cobertura XML: $COBERTURA"
fi

echo ""

exit "$EXIT_CODE"
