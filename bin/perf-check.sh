#!/bin/bash
# Performance regression check for specrails-core.
# This is a template/installer repo — no runtime benchmarks apply.
# Reports NO_PERF_IMPACT so the CI workflow exits cleanly.
set -euo pipefail

FILES="${MODIFIED_FILES_LIST:-}"
CONTEXT="${2:-}"

# Determine if any performance-sensitive files were modified.
# For specrails-core (a shell installer + markdown template repo), there are
# no runtime execution paths to benchmark. All changes are to installer scripts
# or template files that have no measurable latency or throughput impact.

echo "specrails-core performance check"
echo "Modified files: ${FILES:-<none>}"
echo ""
echo "This repository contains shell installer scripts and Markdown templates."
echo "No runtime benchmarks apply — skipping performance regression analysis."
echo ""
echo "PERF_STATUS: NO_PERF_IMPACT"
