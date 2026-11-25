---
description: Explain or diagnose what you selected in the k8sh TUI (press f there first)
argument-hint: "[question]"
---

Call the k8sh `tui_focus` tool. If it is older than ~10 minutes, mention that and ask the user to press `f` again if they meant something newer.

Then answer `$ARGUMENTS` about that object. If no question was given, explain the object's state and whether anything is wrong.
- Pods, containers, findings, warning events: run the `rca-runbook` steps for that object (read-only), using `k8s_describe`, `k8s_logs` and `k8s_events` as needed.
- Argo CD apps and resources: explain sync and health, and the most likely reason for drift.
- Propose fixes as GitOps changes. If a destructive action is needed, tell the user they can select the object in the TUI and press `u`. Never run it yourself without their grant.
