---
description: Search cloud or cluster logs for errors around an incident (read-only)
argument-hint: "<cloud|k8s> <service/log group/namespace> [time window] [query]"
---

Search logs for: $ARGUMENTS. Follow the `cloud-ops` skill (Logs table). Kubernetes workloads use k8sh `k8s_logs`, or Loki through Grafana MCP. Return the matching lines (redacted), a timeline, and the likely cause. Hand off to `/k8s-handler:rca` if it's a cluster workload.
