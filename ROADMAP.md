# Roadmap

What shipped is in [CHANGELOG.md](CHANGELOG.md). Next, roughly in order:

| Milestone | Scope |
|---|---|
| **0.6.x Operations, rest** | Validation view in the pane; Grafana panel links; alert hand-off (Slack, PagerDuty via their MCP servers); incident export to GitHub issues; a Setup view in the pane fed by `doctor`; pane hotkeys for actions; Revoke all and grant countdowns in the Lock tab |
| **0.7 Hard isolation** | k8sh daemon as a separate OS user, grants in memory, socket peer-credential checks; a short-lived break-glass token via TokenRequest per grant (closes the same-user limit in [SECURITY.md](SECURITY.md)) |
| **0.8 GitOps write path** | templates (app, overlay, ExternalSecret, Application/AppProject), live-vs-rendered diff with prune detection, PR creation (GitHub first) |
| **0.9 Security depth** | image scanning and SBOMs (Trivy/Grype/Syft), kube-bench via a GitOps Job, RBAC analysis, cosign verification; Kyverno policy authoring (audit → enforce); scheduled cloud posture diffs |
| **0.10 Live verification** | Argo Rollouts analysis, smoke tests, SLO deltas via Prometheus/Grafana MCP |
| **0.11 Resilience** | capacity (rightsizing loops, k6), chaos (Chaos Mesh/Litmus via Argo Workflows, SLO abort), DR/HA (Velero drills, RTO/RPO, rebuild-from-Git); all destructive paths behind grants |
| **0.12 Claude Desktop** | `.mcpb` packaging, MCP Apps views, elicitation confirmations |
| **0.13 Fleet ops** | CRD explorer, inference (KServe/vLLM), upgrades for AKS/EKS/GKE and on-prem via Ansible |
