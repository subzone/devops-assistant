# Roadmap

**v0.3:** multi-cloud infra skills (design, Terraform/OpenTofu, Crossplane, cloud ops), Terraform/Crossplane validation, cloud CLI guard.

**v0.1:** TUI (Cluster, Argo CD, RCA, Lock views; mouse; focus bridge; in-TUI unlock), local config commands, lock/grants, redaction, guardrail hook, audit log, read-only MCP tools (k8s, Argo CD, RCA), validation pipeline, plugin commands, skills, agents.

| Milestone | Scope |
|---|---|
| v0.2 Hard isolation | k8sh daemon as a separate OS user, grants in memory, socket peer-cred checks; short-lived break-glass token via TokenRequest per grant |
| v0.3 GitOps write path | templates (app, overlay, ExternalSecret, Application/AppProject), live-vs-rendered diff with prune detection, PR creation (GitHub first) |
| v0.4 k8s pane | `/k8s`: the cluster view as a Claude Code mod docked beside the chat (Cluster, Argo CD, RCA, Lock; Ask Claude; pane unlock via `k8sh grant-from-ui`). Done in 0.4.0. |
| v0.4.x Pane (rest) | Validation and Security views, Fleet view across contexts, Grafana panel links, live refresh |
| v0.5 Security | Trivy/Grype/Syft, kube-bench, Kubescape, RBAC analysis, cosign; Kyverno policy authoring (audit → enforce) |
| v0.6 Live verification | Argo Rollouts analysis, smoke tests, SLO deltas via Prometheus/Grafana MCP |
| v0.7 Resilience | capacity (rightsizing, k6), chaos (Chaos Mesh/Litmus via Argo Workflows, SLO abort), DR/HA (Velero drills, RTO/RPO, rebuild-from-Git); all destructive paths behind grants |
| v0.8 Claude Desktop | `.mcpb` packaging, MCP Apps views, elicitation confirmations |
| v0.9 Fleet ops | CRD explorer, inference (KServe/vLLM), upgrades for AKS/EKS/GKE and on-prem via Ansible |
