---
description: Set up devops-assistant — context tiers, Claude settings (deny-list + status line), observability, RBAC
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch version), Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch config:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch settings:*)
---

Configure devops-assistant for the user. Do the work yourself with the commands below. Ask before writing, and don't hand the user snippets to paste.

`K="${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch"`

1. **Binary:** run `"$K" version`. If it fails: install Go 1.24+ (auto-build) or download a release binary.
2. **Context tiers:**
   - Run `"$K" config show` and `k8s_contexts`.
   - For each context not configured yet, ask its tier in one question (dev / staging / prod). Suggest dev for local clusters (`kind-*`, `k3d-*`, `minikube`, `docker-desktop`, `rancher-desktop`) and prod for anything you're unsure about.
   - Apply each with `"$K" config set-tier <context> <tier>`.
   - Note: tiers are labels. Destructive actions stay locked on every tier.
3. **Claude settings** (deny-list + status line):
   - Run `"$K" settings apply --statusline "$K statusline" --dry-run` and show what would be added.
   - Ask once, then run it without `--dry-run`. It only adds rules, keeps a `.bak` and never replaces an existing status line. If one exists, ask before rerunning with `--force-statusline`.
   - Use the stable marketplace path for the status line (`~/.claude/plugins/marketplaces/subzone/bin/k8sh-launch statusline`), not the versioned cache path.
4. **Observability** (optional): if they want Grafana, show the `claude mcp add grafana …` command from `docs/observability.md`. The token stays in their shell or keychain, so they run that command themselves.
5. **Cluster RBAC:** if any context is staging or prod, recommend `docs/rbac/agent-readonly.yaml` for the identity Claude uses there. Local dev clusters can stay as they are.
6. Finish by running `/devops-assistant:status`.
