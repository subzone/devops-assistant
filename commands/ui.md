---
description: Open the k8sh TUI next to Claude (clickable Cluster / Argo CD / RCA / Lock views)
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch tui --open)
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch" tui --open` and report the result in one line.

If it couldn't open a pane, give the user the printed command to run in a terminal next to Claude.

Then explain in two lines how to use it:
- click or press ⏎ to expand, `e` for events, `l` for logs
- `f` sends the selection to Claude (`/k8s-handler:explain`), and `u` unlocks one destructive action for the selection after they type the context name
