## 1. install.sh — Add opt-in prompt

- [x] 1.1 Add Y/n prompt before web-manager installation in Phase 3b: "Install Workflow Manager — Experimental (web UI for managing pipelines)? [Y/n]"
- [x] 1.2 Skip prompt and show warning if npm is not available (preserve current behavior)
- [x] 1.3 If user declines, skip web-manager installation entirely and set `HAS_WEB_MANAGER=false`

## 2. update.sh — Remove auto-install path

- [x] 2.1 In `do_web_manager()`, replace the "Not installed — full install" branch (lines 672-693) with a skip message: "Web manager not installed — skipping (install with install.sh)"
- [x] 2.2 Verify `--only web-manager` exits cleanly when web-manager is not installed

## 3. Tests

- [x] 3.1 Update `tests/test-install.sh` to cover the new prompt (test both accept and decline paths)
- [x] 3.2 Update `tests/test-update.sh` to verify update skips web-manager when directory doesn't exist
