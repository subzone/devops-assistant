# devops-assistant

A Claude Code plugin for DevOps work on Kubernetes, six clouds and on-prem — **GitOps-first, read-only by default, with a hard lock on destructive actions and zero credential exposure.**

| | |
|---|---|
| **See** | `/k8s` docks a live cluster view beside the chat: Cluster, Argo CD, RCA, Lock, Fleet, Security and Incidents tabs, with Steve, a grumpy DevOps engineer who listens and talks back. |
| **Diagnose** | Ranked RCA with history ("since when?"), background monitoring with alerts, incidents with timelines and postmortem drafts. |
| **Analyse** | Read-only security, inventory and cost reviews across AWS, Azure, GCP, Hetzner, DigitalOcean, Alibaba, your clusters and on-prem (vSphere, Proxmox, KVM, bare metal). |
| **Design** | Infrastructure and network designs with diagrams as code and a Well-Architected review, turned into validated Terraform/OpenTofu or Crossplane. |
| **Change** | Only through Git → PR → Argo CD, after a validation pipeline (render, secrets, schema, lint, policy, security, cost). |
| **Stay safe** | A guard hook blocks destructive and secret-reading commands. Destructive actions need a single-use, exact-scope, ≤15-minute grant that **you** issue. Secrets are redacted everywhere. |

Everything runs on your machine with your existing logins: one static Go binary (`k8sh`, standard library only) that shells out to `kubectl` and the cloud CLIs.

## Install

```
/plugin marketplace add subzone/devops-assistant
/plugin install devops-assistant@subzone
/devops-assistant:setup
```

`/devops-assistant:setup` gets the `k8sh` binary (release download checked against its SHA256, or a build from source when Go is installed), checks which tools each feature can use (`k8sh doctor`), installs the groups you pick after you confirm, sets your context tiers, the deny-list and status line, and recommends read-only identities. Details: [Getting started](docs/getting-started.md) · [Dependencies](docs/dependencies.md).

Coming from `k8s-handler` (renamed in 0.5.0)? Reinstall once: `/plugin uninstall k8s-handler@subzone`, `/plugin marketplace update subzone`, `/plugin install devops-assistant@subzone`, then `/devops-assistant:setup`. Your `~/.k8sh` stays as it is.

## Commands

| Command | What it does |
|---|---|
| `/k8s` · `/devops-assistant:ui` | open or close the k8s pane beside the chat ([guide](docs/k8s-pane.md)) |
| `/devops-assistant:status [context]` | contexts and tiers, lock state, Argo CD apps, top warnings |
| `/devops-assistant:rca <ns> [context] [workload]` | read-only root-cause analysis |
| `/devops-assistant:infra-security […]` | security overview of clouds, clusters or on-prem ([analysis](docs/analysis.md)) |
| `/devops-assistant:infra-inventory […]` | what runs where, orphans, untagged, click-ops |
| `/devops-assistant:infra-costs [clouds]` | cloud cost totals, trends, drivers, waste |
| `/devops-assistant:k8s-costs [context]` | cluster cost per namespace/team, idle capacity, rightsizing |
| `/devops-assistant:onprem …` | vSphere/Proxmox/KVM/bare-metal inventory, capacity, end-of-life |
| `/devops-assistant:infra-logs …` | cloud or cluster log search around an incident |
| `/devops-assistant:infra-design <system>` | design + diagrams + validated IaC + WAF review ([design](docs/design.md)) |
| `/devops-assistant:deploy <change>` | GitOps change: branch → edit → validate → diff → PR ([GitOps](docs/gitops.md)) |
| `/devops-assistant:validate <path> [context]` | run the validation pipeline |
| `/devops-assistant:unlock …` | print the `k8sh unlock` command for **you** to run |
| `/devops-assistant:lock` | revoke all grants |
| `/devops-assistant:explain [question]` | explain what you sent from the standalone TUI |
| `/devops-assistant:setup` | binary, tools, tiers, settings, observability, RBAC |

Skills load on their own when a request fits: `k8s-safety`, `rca-runbook`, `gitops-authoring`, `iac-terraform`, `iac-crossplane`, `infra-design`, `cloud-ops`, `cloud-security`, `cloud-inventory`, `k8s-cost`, `onprem-ops`. Agents: `rca-investigator`, `manifest-validator`, `infra-architect`, `cloud-cost-analyst`, `security-auditor`, `inventory-analyst`.

## How safe is it?

- **Read-only by default.** The PreToolUse guard blocks destructive `kubectl`/`helm`/`argocd`/`terraform` commands, mutating cloud CLI calls, scanners' fix modes, non-read on-prem commands, secret reads and credential files, and keystroke or pseudo-terminal tricks. It fails closed.
- **Destructive actions are locked.** `destructive_*` tools need a grant you issue in your own terminal or in the pane by typing the context name:
  ```bash
  k8sh unlock --context eks-prod --namespace payments --action delete --target pod/api-7f9c
  #   Type the context name to confirm: eks-prod
  #   🔓 granted 3f2a… — single use, expires 22:14:05
  ```
- **No credentials anywhere.** Values are redacted in every tool result, the audit log and the UI; generated manifests use `ExternalSecret`.

The full model, including its known limits: [SECURITY.md](SECURITY.md). Read-only identities to use: [Kubernetes](docs/rbac/agent-readonly.yaml), [clouds and on-prem](docs/rbac/cloud-readonly.md).

## MCP tools

- **Read:** `k8s_contexts`, `k8s_get`, `k8s_describe`, `k8s_events`, `k8s_logs`, `argo_apps`, `argo_app_tree`, `rca_collect`, `rca_history`, `fleet_status`, `security_overview`, `incident_list`, `validate_manifests`, `lock_status`, `doctor`, `tui_focus`
- **Local records** (this machine only, never a cluster): `incident_open`, `incident_note`, `incident_status`
- **Locked:** `destructive_delete`, `destructive_scale_zero`

Prometheus and Grafana work through their own MCP servers next to this one: [docs/observability.md](docs/observability.md).

## Documentation

| Page | |
|---|---|
| [Getting started](docs/getting-started.md) | install, the binary, setup, first steps, upgrading |
| [Dependencies](docs/dependencies.md) | every external tool per feature, `k8sh doctor`, installing |
| [k8s pane](docs/k8s-pane.md) | tabs, monitoring, incidents, unlock, Steve's voice and ears |
| [Analysis](docs/analysis.md) | security, inventory, cost and on-prem reviews |
| [Design](docs/design.md) | infrastructure design, diagrams, where to see them |
| [GitOps and validation](docs/gitops.md) | the change path, the validation pipeline, CI, IaC reconciliation |
| [Observability](docs/observability.md) | Grafana and Prometheus MCP |
| [CLI reference](docs/cli.md) | every `k8sh` command |
| [SECURITY.md](SECURITY.md) · [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md) | |

## Repository layout
```
cmd/k8sh/            CLI + MCP entrypoint (doctor.go: tool check)
internal/guard       PreToolUse decisions (readonly.go: on-prem allow-lists)
internal/grant       destructive-action lock
internal/redact      credential scrubbing
internal/kube        kubectl wrapper, Argo CD, RCA, fleet, security checks
internal/history     RCA history (~/.k8sh/rca-history.json)
internal/incident    incidents (~/.k8sh/incidents.json)
internal/doctor      which tools each feature can use, install plans
internal/validate    validation pipeline (Kubernetes, Terraform, Crossplane)
internal/mcp         stdio MCP server + tools
internal/tui         standalone terminal UI (fallback for hosts without mods)
internal/focus       TUI → Claude selection bridge
bin/k8sh-launch      finds, builds or downloads (SHA256-checked) the k8sh binary
hooks/k8s-pane.js    the k8s pane (Claude Code mod); tests in hooks/k8s-pane.test.ts
hooks/steve.js, steve-frames.js, infinity.js   the pane's backdrops
commands/ skills/ agents/   slash commands, skills and subagents
docs/                guides, RBAC, settings
.claude-plugin/      plugin + marketplace manifests
types/index.d.ts     the pane's state contract
```

Build and test: `make build test vet`; `make dist` cross-compiles release binaries. A `v*` tag publishes them with `SHA256SUMS` (`.github/workflows/release.yml`).

## License
MIT
