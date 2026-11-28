---
name: k8s-cost
description: Read-only Kubernetes cost allocation per namespace, workload, team and label, idle capacity and rightsizing, from OpenCost/Kubecost when installed or estimated from requests and node prices otherwise, and joined with the cloud bill. Use when the user asks what a namespace, team or app costs, about cluster waste, idle nodes, overprovisioned requests or rightsizing.
---

# Kubernetes cost (read-only)

## 1. Find the cost engine
k8sh `k8s_get` services across namespaces and look for `opencost` (API port 9003) or `kubecost-cost-analyzer` (port 9090).

- **OpenCost**: one read through the API server, nothing to port-forward:
  `kubectl get --raw "/api/v1/namespaces/<ns>/services/opencost:9003/proxy/allocation/compute?window=7d&aggregate=namespace&accumulate=true"`
  Aggregate by `namespace`, `controller`, `pod`, `label:<key>` (e.g. `label:team`) or `cluster`. Window: `24h`, `7d`, `30d`, `lastweek`, `month`.
- **Kubecost**: `kubectl get --raw "/api/v1/namespaces/<ns>/services/kubecost-cost-analyzer:9090/proxy/model/allocation?window=7d&aggregate=namespace&accumulate=true"`.
- If the agent's RBAC lacks `services/proxy`, use `kubectl port-forward -n <ns> svc/opencost 9003:9003` in the background, query `http://localhost:9003/allocation/compute?...`, then stop it.
- **Neither installed**: say so, estimate (step 2), and offer OpenCost as a GitOps change (Argo CD Application for the `opencost` Helm chart via `gitops-authoring`, pointed at the cluster's Prometheus), never `helm install`.

## 2. Estimate without a cost engine
1. Node prices: instance type from the `node.kubernetes.io/instance-type` label, price from the real bill (`cloud-ops` costs, filtered by the cluster's tag: `eks:cluster-name`, AKS `MC_…` resource group, GKE `goog-k8s-cluster-name`, DOKS `k8s:<id>`), or `hcloud server-type list -o json` on Hetzner. Ask the user for a price only when none of these is available, and label the result as an estimate.
2. Split each node's cost by requests: a pod's share = max(cpu request / node allocatable cpu, memory request / node allocatable memory). Sum per namespace, controller and label.
3. **Idle** = node cost not covered by any request. Report it as its own line, not spread.
4. Do it in a script over `kubectl get nodes,pods -A -o json` output; never eyeball it.

## 3. Rightsizing
- Usage: Prometheus via Grafana/Prometheus MCP when connected (p95 over 7d of `rate(container_cpu_usage_seconds_total[5m])` and `container_memory_working_set_bytes`, per container); else `kubectl top pods -A --containers` (a snapshot: say so).
- Flag containers whose request is > 2× p95 usage (overprovisioned) or whose usage nears the limit or that were OOMKilled (underprovisioned, see `rca_history`).
- Node level: nodes under 40% requested for most of the window → fewer or smaller nodes (cluster autoscaler / Karpenter settings), spot/preemptible for stateless pools.

## 4. Join with the cloud bill
Cluster cost from the bill vs the allocation total: the gap is control plane, load balancers, volumes, egress and NAT. Name the biggest of those (`cloud-inventory` finds orphaned LBs and volumes).

## 5. Report
- Cost per namespace (or team/app) for the window, the top 10, and the trend vs the previous window.
- Idle capacity in money and %, and the rightsizing list with the expected monthly saving per item.
- Each saving is a concrete change: the manifest/values file, the new requests/limits or node-pool size, as a PR through `/devops-assistant:deploy`. Nothing is changed from here.
