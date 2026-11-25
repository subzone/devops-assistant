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

## Commands

| Command | What it does |
|---|---|
| `/k8s-handler:status [context]` | contexts + tiers, lock state, Argo CD apps, top warnings |
| `/k8s-handler:rca <ns> [context] [workload]` | read-only root-cause analysis |
| `/k8s-handler:validate <path> [context]` | validation pipeline |
| `/k8s-handler:deploy <change>` | GitOps change: branch → edit → validate → diff → PR |
| `/k8s-handler:unlock …` | prints the `k8sh unlock` command for you to run (user-only) |
| `/k8s-handler:lock` | revoke all grants |
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

Read: `k8s_contexts`, `k8s_get`, `k8s_describe`, `k8s_events`, `k8s_logs`, `argo_apps`, `argo_app_tree`, `rca_collect`, `validate_manifests`, `lock_status`
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
.claude-plugin/      plugin + marketplace manifests
commands/ skills/ agents/ hooks/   Claude Code plugin
docs/                RBAC, settings, observability
```

## Roadmap
See [ROADMAP.md](ROADMAP.md).

## License
MIT
