# Roadmap

**v0.1 (this release):** lock/grants, redaction, guardrail hook, audit log, read-only MCP tools (k8s, Argo CD, RCA), validation pipeline, plugin commands, skills, agents.

| Milestone | Scope |
|---|---|
| v0.2 Hard isolation | k8sh daemon as a separate OS user, grants in memory, socket peer-cred checks; short-lived break-glass token via TokenRequest per grant |
| v0.3 GitOps write path | templates (app, overlay, ExternalSecret, Application/AppProject), live-vs-rendered diff with prune detection, PR creation (GitHub first) |
| v0.4 TUI | `k8sh tui` (Bubble Tea): Fleet, Apps tree, Validation, Security, Lock & Grants, RCA; `focus.json` bridge to Claude; `/k8s-handler:ui` |
| v0.5 Security | Trivy/Grype/Syft, kube-bench, Kubescape, RBAC analysis, cosign; Kyverno policy authoring (audit → enforce) |
| v0.6 Live verification | Argo Rollouts analysis, smoke tests, SLO deltas via Prometheus/Grafana MCP |
| v0.7 Resilience | capacity (rightsizing, k6), chaos (Chaos Mesh/Litmus via Argo Workflows, SLO abort), DR/HA (Velero drills, RTO/RPO, rebuild-from-Git); all destructive paths behind grants |
| v0.8 Claude Desktop | `.mcpb` packaging, MCP Apps views, elicitation confirmations |
| v0.9 Fleet ops | CRD explorer, inference (KServe/vLLM), upgrades for AKS/EKS/GKE and on-prem via Ansible |
