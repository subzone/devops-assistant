---
description: Set up k8s-handler — context tiers, status line, optional Grafana/Prometheus MCP
---

Guide the user through setup. Do the read-only checks yourself, and give the user the exact snippets to apply.

1. **Binary:** run `"${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch" version`. If it fails, tell them to install Go 1.24+ (auto-build) or download a release binary into the plugin's `bin/`.
2. **Context tiers:** list contexts with `k8s_contexts`. Unknown contexts count as **prod**. Ask which are dev/staging, then give them this file to create **themselves** at `~/.k8sh/config.json`. You cannot write to `~/.k8sh`; the guardrail blocks it on purpose:
   ```json
   { "contexts": { "kind-dev": {"tier": "dev"}, "aks-staging": {"tier": "staging"} }, "maxGrantTTLMinutes": 10 }
   ```
3. **Status line** (optional): add to `~/.claude/settings.json`:
   ```json
   { "statusLine": { "type": "command", "command": "<plugin-root>/bin/k8sh-launch statusline" } }
   ```
4. **Observability MCP** (optional): point them to `docs/observability.md` for Grafana MCP / Prometheus MCP. Tokens go in their shell environment or OS keychain, never in a repo file.
5. **Cluster RBAC** (recommended): point to `docs/rbac/agent-readonly.yaml`, a read-only ClusterRole for the identity Claude uses.
6. **Settings deny-list**: point to `docs/recommended-settings.json`.
