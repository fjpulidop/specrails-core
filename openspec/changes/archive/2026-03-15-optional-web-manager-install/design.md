## Context

Web-manager is installed silently in `install.sh` Phase 3b whenever npm is available. In `update.sh`, `do_web_manager()` has two branches: update if installed, or full-install if not present. The change makes installation opt-in via a prompt and removes the auto-install path from updates.

## Goals / Non-Goals

**Goals:**
- User explicitly chooses whether to install web-manager during `/setup`
- `update.sh` only touches web-manager if it's already installed
- Uninstalling = deleting `specrails/web-manager/`

**Non-Goals:**
- Persisting the user's preference in a config file (presence of directory is the signal)
- Adding an `--install-web-manager` flag to update.sh
- Changing any web-manager functionality

## Decisions

### Decision 1: Directory presence as preference signal
Use the existence of `specrails/web-manager/` as the sole indicator of whether web-manager is wanted. No config file or manifest entry needed.

**Why**: Simplest approach. Already works naturally — if it's not there, don't update it. Uninstall is just `rm -rf`. No state to get out of sync.

### Decision 2: Default yes on install prompt
The prompt defaults to Yes (`[Y/n]`) because web-manager adds value and most users will want it. The prompt is about informed consent, not discouragement.

### Decision 3: Skip prompt if npm unavailable
If npm is not available, skip the prompt entirely and show a warning (current behavior). No point asking if we can't install.

## Risks / Trade-offs

- [Users who said no can't easily install later without re-running install.sh] → Document manual install: copy templates + npm install
- [Existing update.sh auto-installs on fresh dirs] → Removing this path means users who delete web-manager won't get it back on update (this is the desired behavior)
