# Changelog

## 0.6.1 — 2026-11-28
**Analysis, dependencies and docs**
- New read-only analysis skills, agents and commands: `cloud-security` (`/infra-security`: Prowler, Security Hub/Defender/SCC, quick checks for six clouds, cluster checks), `cloud-inventory` (`/infra-inventory`: one table across clouds matched with clusters and Git: orphans, untagged, click-ops), `k8s-cost` (`/k8s-costs`: OpenCost/Kubecost or an estimate, idle, rightsizing), `onprem-ops` (`/onprem`: vSphere, Proxmox, KVM, bare metal: capacity, N+1, health, end-of-life).
- `k8sh doctor` and the `doctor` MCP tool: which tools each feature can use, versions, and install commands; `/devops-assistant:setup` installs only the groups you pick, after you confirm.
- The launcher downloads the release binary for the plugin's version and installs it only if its SHA256 matches `SHA256SUMS`, so Go is no longer required (`K8SH_NO_DOWNLOAD=1` turns it off; never inside the guard hook).
- Guard: allow-lists for `govc`, `pvesh`, `qm`, `pct`, `virsh` and ad-hoc `ansible` (fact modules only); blocks Prowler `--fix`, `trivy k8s` without `--disable-node-collector`, cloud storage writes, `ansible-inventory --list/--host`, `ansible-vault view/decrypt`, `govc vm.info -e`, `virsh --security-info`. The hook command quotes the plugin path.
- Design: diagrams inline as Mermaid in the README (render on GitHub/VS Code), SVGs when `mmdc`/`d2` exist, reviews of existing environments.
- Docs rewritten into guides under `docs/`; read-only identities in `docs/rbac/cloud-readonly.md`.

## 0.6.0 — 2026-11-27
**Operations**
- k8s pane: Fleet, Security and Incidents tabs; RCA history in the RCA tab; background monitoring with a baseline and alerts; incidents with timeline, notes, mitigate/resolve/reopen and postmortem drafts.
- MCP: `fleet_status`, `security_overview`, `rca_history`, `incident_list|open|note|status`; `rca_collect` records history.
- Fixed: kubectl 1.37 rejects `--all-namespaces` before the verb (all-namespace queries failed); past problems (old OOM kills, finished Job pods, old restarts) no longer count as current; RCA reads init containers.

## 0.5.x — 2026-11-26
- 0.5.4: Steve reads Claude's answers only when you turn it on (one small haiku call per answer).
- 0.5.3: Steve speaks with Piper and hears you with whisper.cpp, all on your machine.
- 0.5.2: namespace health, init containers, pods grouped by owner, actions on top.
- 0.5.1: Steve, a grumpy DevOps backdrop who listens and talks.
- 0.5.0: **renamed `k8s-handler` → `devops-assistant`** (reinstall once).

## 0.4.x — 2026-11-26
- 0.4.1: rotating 3D ∞ backdrop.
- 0.4.0: the k8s pane as a Claude Code mod (`/k8s`): Cluster, Argo CD, RCA, Lock; Ask Claude; pane unlock via `k8sh grant-from-ui`.

## 0.3 — 2026-11-26
- Multi-cloud infrastructure: design, Terraform/OpenTofu, Crossplane, cloud ops skills; Terraform/Crossplane validation; cloud CLI guard.
- TUI: clickable menus, context dropdown, back navigation.

## 0.2 — 2026-11-25
- `k8sh tui` with clickable trees, focus bridge and in-TUI unlock; `k8sh workspace` (tmux layout); `/ui` and `/explain` commands.

## 0.1 — 2026-11-25
- Lock and grants, redaction, guardrail hook, audit log, read-only MCP tools (Kubernetes, Argo CD, RCA), validation pipeline, local config commands, plugin commands, skills and agents.
