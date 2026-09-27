# Converted OpenSpec lifecycle commands

27 September 2026. Legacy Quick SDD skips validation/archive commands when the
frozen target is already archived. Arbitrary shell execution also depends on a
global OpenSpec executable. Conversion must use the pinned Core OpenSpec pieces
for the exact known lifecycle commands, preserving the selected artifact root.

Add explicit allowArchived behavior to these pieces. It only skips a command when
the active target is absent and a real archived directory for that exact change
exists inside the artifact root. Symlink paths remain rejected. The result records
archived/skipped and never invents a validation or verification receipt. An active
target always takes precedence. The default remains strict. Converted writers
still need real host verification before successful completion.

This is versioned optional behavior; arbitrary authored shell commands remain
shell commands and are never rewritten by substring matching. A different bound
repository cannot silently become the artifact repository. Conversion and launch
must check that binding before executing a specialized OpenSpec piece.

Catalog version 5 advertises these optional parameters. Acceptance covers actual
Quick SDD archive/revisit, strict-default rejection, active-target precedence,
symlink boundaries, mismatched repository scope, and CLI versus infrastructure
errors. Installed-package run/resume/fork checks also pass.
