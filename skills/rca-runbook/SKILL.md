---
name: rca-runbook
description: Read-only root-cause analysis runbook for Kubernetes incidents (CrashLoopBackOff, OOMKilled, image pull errors, Pending pods, failed rollouts, Argo CD Degraded/OutOfSync, latency or error spikes). Use when diagnosing a cluster or workload problem.
---

# RCA runbook (read-only)

1. **Scope.** Context and tier (`k8s_contexts`), namespace, workload, and when the problem started.
2. **Signals.** Call `rca_collect` for the namespace. Start from the highest-severity findings.
3. **Change correlation.** Use `argo_apps` / `argo_app_tree`: sync status, revision, last operation. Check the Git log for the app path around the start time. Most incidents follow a change.
4. **Workload detail.** Use `k8s_describe` on the pod/deployment and `k8s_logs` (use `previous: true` for crash loops).
5. **Metrics** (if Grafana/Prometheus MCP is connected):
   - restarts: `increase(kube_pod_container_status_restarts_total{namespace="<ns>"}[30m])`
   - memory vs limit: `container_memory_working_set_bytes / on(pod,container) kube_pod_container_resource_limits{resource="memory"}`
   - errors: `sum(rate(http_requests_total{namespace="<ns>",status=~"5.."}[5m])) / sum(rate(http_requests_total{namespace="<ns>"}[5m]))`
   - scheduling: `kube_pod_status_phase{phase="Pending"}`, node allocatable vs requests
6. **Quick patterns:**
   | Signal | Usual cause | Check |
   |---|---|---|
   | OOMKilled | limit too low / leak | memory trend vs limit |
   | CrashLoopBackOff | config/env, missing secret, bad migration | previous logs, recent commit |
   | ImagePullBackOff | tag missing, registry auth | image tag in Git vs registry |
   | Pending | requests > capacity, taints, PVC | describe pod events, node pool |
   | Readiness failing | dependency down, wrong probe | logs, endpoints |
7. **Conclusion.** Most likely cause with evidence, ranked alternatives, and the fix as a GitOps change. Destructive remediation gets the unlock command for the user; you never run it.
