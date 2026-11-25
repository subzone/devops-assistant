---
description: Cluster, lock and Argo CD status overview
argument-hint: "[context]"
---

Give a compact status overview using the k8sh MCP tools (read-only):

1. `k8s_contexts` — list contexts with tier; mark the current one. Use `$ARGUMENTS` as the context if given.
2. `lock_status` — show lock state and any active grants.
3. `argo_apps` for that context — table of apps: name, sync, health, auto-prune flag. Put OutOfSync / Degraded / Missing first.
4. `k8s_events` (warnings only, all namespaces) — top 5 warnings.

Output: one short table per section, then one line "Needs attention:" with the most important item. No speculation.
