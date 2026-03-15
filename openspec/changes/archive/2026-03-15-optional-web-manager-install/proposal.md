## Why

Web-manager is currently installed silently during `/setup` (Phase 3b) whenever npm is available. As an experimental UI component with Node.js dependencies, it should be an explicit opt-in choice — users who only want the core agent workflow shouldn't have React/Express installed automatically.

## What Changes

- `install.sh` Phase 3b prompts the user before installing web-manager, with a clear "Experimental" label and default yes
- `update.sh` only updates web-manager if it's already installed (directory exists); never auto-installs it
- Update the `update-system` spec to reflect the new conditional behavior for web-manager

## Capabilities

### New Capabilities

_None — this change modifies existing installation behavior._

### Modified Capabilities

- `update-system`: Web manager requirement changes from "install if not present" to "update only if already installed"

## Impact

- **install.sh**: Phase 3b adds a Y/n prompt before web-manager installation
- **update.sh**: Conditional logic change — skip web-manager entirely if `specrails/web-manager/` doesn't exist
- **Uninstall path**: Users can remove web-manager by deleting `specrails/web-manager/`; subsequent updates will not reinstall it
