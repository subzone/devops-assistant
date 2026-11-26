---
description: Open the k8s pane beside this chat (same as /k8s)
---

The k8s pane is a Claude Code mod in this plugin: `/k8s` opens and closes it, and the mod answers `/devops-assistant:ui` itself. If you are reading this, the mod did not answer, so this Claude Code is not loading the plugin's hooks module.

Tell the user, in two or three lines:
- Type `/k8s`. If it isn't listed, update Claude Code and restart the session so the devops-assistant mod loads (`claude --debug` names the reason when a mod doesn't load).
- Until then the standalone TUI works in their own terminal: `k8sh tui`, or `k8sh workspace --continue` for chat and TUI side by side in tmux.

Run nothing yourself.
