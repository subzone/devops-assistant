# devops-assistant documentation

GitOps-first DevOps for Claude Code: a live k8s pane, RCA and incidents, read-only security/inventory/cost analysis for clouds, clusters and on-prem, infrastructure design, and a change path that only goes through Git — behind a hard lock on destructive actions.

**Start here:** [Getting started](getting-started.md)

| Guide | What's in it |
|---|---|
| [Getting started](getting-started.md) | install, how the `k8sh` binary is found or downloaded, `/devops-assistant:setup`, first steps, upgrading |
| [Dependencies](dependencies.md) | every external tool per feature group, `k8sh doctor`, installing what you pick |
| [k8s pane](k8s-pane.md) | `/k8s`: tabs, navigation, fleet, security, RCA history, monitoring, incidents, unlock, Steve |
| [Analysis](analysis.md) | `/infra-security`, `/infra-inventory`, `/infra-costs`, `/k8s-costs`, `/onprem`: what each checks and returns |
| [Design](design.md) | `/infra-design`: requirements → diagrams → WAF review → validated IaC, and where to see it |
| [GitOps and validation](gitops.md) | `/deploy`, the validation pipeline, CI, Terraform/Crossplane reconciliation |
| [Observability](observability.md) | Grafana and Prometheus MCP next to k8sh |
| [CLI reference](cli.md) | every `k8sh` command |
| [RBAC: Kubernetes](rbac/agent-readonly.yaml) · [RBAC: clouds and on-prem](rbac/cloud-readonly.md) | read-only identities |
| [Security model](https://github.com/subzone/devops-assistant/blob/main/SECURITY.md) · [Roadmap](https://github.com/subzone/devops-assistant/blob/main/ROADMAP.md) · [Changelog](https://github.com/subzone/devops-assistant/blob/main/CHANGELOG.md) | |

Design notes: [k8s pane as a Claude Code mod (phase 1 plan)](plan/side-pane-mod.md).
