---
description: Show the k8s TUI as a right-side pane next to this chat (iTerm2, tmux, WezTerm, kitty)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch tui --open)
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch" tui --open` and show its output verbatim.

- If it opened a pane: say in one line that the cluster view is on the right and the chat stays here. `f` there sends the selection to `/k8s-handler:explain`.
- If it failed: show the error and the `detected:` line, then give the one fix it suggests (for example the macOS Automation permission). Don't suggest opening a new window.
