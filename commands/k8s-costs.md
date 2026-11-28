---
description: Kubernetes cost per namespace/team/app, idle capacity and rightsizing (OpenCost/Kubecost or an estimate; read-only)
argument-hint: "[context] [window, default 7d] [aggregate: namespace|controller|label:team]"
---

Delegate to the `cloud-cost-analyst` agent, following the `k8s-cost` skill: $ARGUMENTS. Default to the current context, a 7-day window and aggregation by namespace.

Return:
- the source (OpenCost, Kubecost, or an estimate and how it was made)
- cost per namespace (or the chosen aggregate), the top 10 and the trend
- idle capacity in money and %
- the rightsizing list with the expected monthly saving, each as a file + change for a PR
