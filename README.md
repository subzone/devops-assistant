# k8s-handler

GitOps-first Kubernetes operations for Claude Code, with a **hard lock on destructive actions** and **zero credential exposure**.

- Read clusters through MCP: contexts, resources, events, logs, Argo CD apps and trees, ranked RCA signals
- Changes only through Git → PR → Argo CD; never direct cluster mutation
- Validation pipeline for generated code: render (Kustomize/Helm) → secret scan → schema → lint → policy → security → server dry-run
- Destructive actions are locked. Unlocking takes a single-use, exact-scope, ≤15-minute grant that **you** issue in your own terminal
- Secrets redacted everywhere. Generated manifests use `ExternalSecret` only
- Single static Go binary, standard library only, uses your `kubectl` and its cloud auth plugins

See [SECURITY.md](SECURITY.md) for the full model.

## Install

Requires `kubectl`, plus Go 1.24+ (the plugin builds `k8sh` on first use) or a release binary.

```
/plugin marketplace add subzone/k8s-handler
/plugin install k8s-handler@subzone
/k8s-handler:setup
```

Optional CLI on your PATH:
```bash
go install github.com/subzone/k8s-handler/cmd/k8sh@latest
```

## Multi-cloud infrastructure

AWS, Azure, GCP, Hetzner, DigitalOcean, Alibaba Cloud:
- Design: landing zone, network plan (CIDRs, tiers, egress, private endpoints), diagrams as code, Well-Architected review (`infra-design` skill)
- Code: Crossplane (AWS/Azure/GCP providers; `provider-terraform` for Hetzner/Alibaba) or Terraform/OpenTofu with remote state and keyless auth
- Reconciliation: Argo CD syncs Crossplane objects (incl. Terraform `Workspace`s), or an Argo Workflows plan → approve → apply pipeline
- Validation: `validate_manifests` detects Terraform (secrets, fmt, validate, tflint, trivy, checkov, infracost) and Crossplane (`crossplane beta validate`, `deletionPolicy` checks)
- Ops: read-only logs, inventory and costs through each cloud's CLI (`cloud-ops` skill)
- Guard: cloud CLIs are read-only for Claude; `terraform/tofu apply|destroy|import|state …`, `pulumi up`, mutating `aws/az/gcloud/hcloud/doctl/aliyun` calls and token-printing commands are blocked; cloud credential files are unreadable

## k8s pane

Type `/k8s` and the cluster view opens on the right side of the chat, inside the same Claude Code session. You don't need tmux, a second window or a separate process. It works in any terminal, Apple Terminal included, and in the Code tab of the Claude desktop app. `/k8s` again (or Esc while the pane has focus) closes it. `/k8s-handler:ui` opens the same pane.
```
 1: Cluster  2: Argo CD  3: RCA  4: Lock               │  ...chat...
 context k3d-mycluster [dev] ▾   LOCKED                │
 ⌂ Cluster › payments › deploy/api › pod/api-2         │
 ▾ ✔ payments                                          │
   ▾ ⚠ deploy/api  1/2                                 │
     ▸ ✔ pod/api-1  Running                            │
     ▸ ✖ pod/api-2  Running OOMKilled r:7              │
 ───────────────────────────────────────               │
 Pod payments/api-2  phase: Running  restarts: 7       │
 [ Logs ] [ Prev logs ] [ Events ] [ Describe ]        │
 [ Ask Claude ] [ ← Back ] [ ⌂ Top ] [ ⟳ Refresh ]     │
 [ Unlock… ]                                           │
```
- Tabs (hotkeys 1-4): Cluster (namespaces → workloads → pods → containers), Argo CD (apps → resources, problems first), RCA (ranked findings + recent warnings), Lock (lock state, active grants with expiry, contexts and tiers).
- Click a row to select it; click it again to expand or collapse it. The breadcrumb jumps back to any level; `⌂` collapses everything. Long lists show 30 rows with `more…`.
- Logs, previous logs, events and describe open in the detail area (`✕ close` returns to the summary). **Ask Claude** sends a short, redacted description of the selection and the last output to the chat, and Claude diagnoses it with the `rca-runbook` skill.
- The status line shows `k8s <context> [<tier>] LOCKED` (or `UNLOCKED xN`). The pane refreshes on open, on ⟳, on tab or context change, every 15 s while open, and after Claude uses a k8sh tool.
- **Unlock…** on a pod or workload asks you to type the context name, then issues one grant: delete for pods and daemonsets, delete or scale to 0 for deployments and statefulsets. It is single use, for that exact target, expires within 15 minutes and is audited. Only you can press it: Claude has no tool, command or prompt that reaches it.
- Everything shown comes from the k8sh MCP tools, so it is redacted. The pane never reads kubeconfig. Switching the pane's context doesn't change kubectl's current context.
- The right-side dock needs Claude Code's fullscreen layout and a wide enough terminal. Otherwise the pane opens above the prompt, which is normal Claude Code behaviour.

The older standalone TUI (`k8sh tui`, `k8sh workspace`) is still there as a fallback for a Claude Code that doesn't load mods.

## Commands

| Command | What it does |
|---|---|
| `/k8s` | open or close the k8s pane beside the chat |
| `/k8s-handler:ui` | open the k8s pane (same as `/k8s`) |
| `/k8s-handler:explain [question]` | explain/diagnose what you sent from the standalone TUI (`f`); in the pane use Ask Claude |
| `/k8s-handler:status [context]` | contexts + tiers, lock state, Argo CD apps, top warnings |
| `/k8s-handler:rca <ns> [context] [workload]` | read-only root-cause analysis |
| `/k8s-handler:validate <path> [context]` | validation pipeline |
| `/k8s-handler:deploy <change>` | GitOps change: branch → edit → validate → diff → PR |
| `/k8s-handler:unlock …` | prints the `k8sh unlock` command for you to run (user-only) |
| `/k8s-handler:lock` | revoke all grants |
| `/k8s-handler:infra-design <system>` | design + network diagrams (Mermaid/D2) + validated Terraform/Crossplane, WAF review |
| `/k8s-handler:infra-costs [clouds]` | cost totals, trends, drivers, waste (read-only) |
| `/k8s-handler:infra-logs …` | cloud/cluster log search (read-only) |
| `/k8s-handler:setup` | tiers, status line, observability MCP, RBAC |

## Unlocking a destructive action

```bash
# in YOUR terminal, not in Claude
k8sh unlock --context eks-prod --namespace payments --action delete --target pod/api-7f9c
#   DESTRUCTIVE ACTION GRANT ... Type the context name to confirm: eks-prod
#   🔓 granted 3f2a… — single use, expires 22:14:05
```
Claude can then call `destructive_delete` exactly once for that target. `k8sh actions` lists the actions, `k8sh grants` shows active grants, `k8sh lock` revokes them all.

## Configuration

`/k8s-handler:setup` configures everything. Or by hand:
```bash
k8sh config set-tier k3d-mycluster dev      # contexts not listed count as prod
k8sh config set-ttl 10                      # grant TTL ceiling, 1-15 min
k8sh settings apply --statusline "k8sh statusline"   # add-only merge into ~/.claude/settings.json, keeps .bak
```
Tiers are labels: destructive actions stay locked on every tier.

## MCP tools

Read: `k8s_contexts`, `k8s_get`, `k8s_describe`, `k8s_events`, `k8s_logs`, `argo_apps`, `argo_app_tree`, `rca_collect`, `validate_manifests`, `lock_status`, `tui_focus`
Locked: `destructive_delete`, `destructive_scale_zero`

Prometheus and Grafana: use their MCP servers alongside this one. See [docs/observability.md](docs/observability.md).

## CI

```bash
k8sh validate apps/payments/overlays/prod --strict
```
Exits 1 when a required stage fails. With `--strict`, missing scanners count as failures.

## Layout
```
cmd/k8sh/            CLI + MCP entrypoint
internal/guard       PreToolUse decisions
internal/grant       destructive-action lock
internal/redact      credential scrubbing
internal/kube        kubectl wrapper, Argo CD, RCA
internal/validate    validation pipeline
internal/mcp         stdio MCP server + tools
internal/tui         standalone terminal UI (fallback)
internal/focus       TUI → Claude selection bridge
.claude-plugin/      plugin + marketplace manifests
hooks/k8s-pane.js    the k8s pane (Claude Code mod), tests in hooks/k8s-pane.test.ts
types/index.d.ts     the pane's state contract
commands/ skills/ agents/ hooks/   Claude Code plugin
docs/                RBAC, settings, observability
```

## Roadmap
See [ROADMAP.md](ROADMAP.md).

## License
MIT
