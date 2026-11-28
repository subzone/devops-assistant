# Analysis: security, inventory, cost, on-prem

Read-only reviews of what you already run, across **AWS, Azure, GCP, Hetzner, DigitalOcean, Alibaba Cloud**, your Kubernetes clusters, and on-prem (**vSphere, Proxmox, KVM, bare metal**). They use the logins you already have, run only list/describe/get calls, and return every fix as a change in code for a PR. Nothing is changed from the chat.

| Ask | Command | Skill → agent |
|---|---|---|
| Is anything exposed? | `/devops-assistant:infra-security [aws azure gcp hetzner do alibaba k8s onprem …]` | `cloud-security` → `security-auditor` |
| What runs where? | `/devops-assistant:infra-inventory [clouds]` | `cloud-inventory` → `inventory-analyst` |
| What does it cost? | `/devops-assistant:infra-costs [clouds] [period]` | `cloud-ops` → `cloud-cost-analyst` |
| What does each team pay in the cluster? | `/devops-assistant:k8s-costs [context] [window] [aggregate]` | `k8s-cost` → `cloud-cost-analyst` |
| How healthy is on-prem? | `/devops-assistant:onprem <vsphere\|proxmox <host>\|kvm <host>\|ansible <inventory>>` | `onprem-ops` → `inventory-analyst` |
| Logs around an incident | `/devops-assistant:infra-logs <cloud\|k8s> <target> [window] [query]` | `cloud-ops` |

You don't need the commands: "is anything in our Azure subscription public?" or "what does the payments namespace cost per month?" loads the right skill on its own. With nothing named, the commands use whichever cloud CLIs are logged in (identity calls only) and your kube contexts.

## Security overview
1. **Scope:** identity calls (`aws sts get-caller-identity`, `az account show`, `gcloud config list`, …) say who and where.
2. **Scanner first:** Prowler (AWS, Azure, GCP, Kubernetes; never `--fix`, which the guard blocks) or the cloud's own findings: AWS Security Hub, GuardDuty and IAM Access Analyzer; Azure Defender for Cloud secure score and assessments; GCP Security Command Center.
3. **Quick checks** otherwise, per cloud: public storage, firewalls open to the internet, admin identities and root MFA, long-lived keys, unencrypted disks and databases, public databases, audit logging, managed-Kubernetes API exposure. Hetzner, DigitalOcean and Alibaba get firewall, unprotected-server, database and identity checks.
4. **Clusters:** `security_overview` per context (the same checks as the pane's Security tab).
5. **Report:** worst first — severity, check, where, why it matters, the fix (the Terraform/Crossplane resource and attribute); counts; what couldn't be checked and why. Key IDs show their last 4 characters only.

## Inventory
- **Collect** with the broad search per cloud when it's on (AWS Resource Explorer, Azure Resource Graph, GCP Cloud Asset, Alibaba Resource Center), else per-type lists, in every used region.
- **Normalise** into one CSV: cloud, account, region, type, name, id, size, state, created, owner/env/cost-center tags, cluster, managed-by.
- **Match with Kubernetes:** nodes ↔ instances by `providerID`, LoadBalancer Services ↔ cloud load balancers, PVs ↔ volumes. What nobody points at is an **orphan**.
- **Match with Git:** resources without `managed-by` and not in the repo's Terraform/Crossplane are **click-ops**, candidates for import (proposed as a PR).
- **Report:** counts per cloud × type and per owner, orphans with evidence, untagged %, click-ops, oldest non-prod, what couldn't be listed.

## Cloud cost
Actuals per cloud (Cost Explorer, Cost Management, the BigQuery billing export, Hetzner's price list × servers, DigitalOcean billing, Alibaba BSS), computed in a script: totals per service, the trend vs the previous period, the top 5 drivers, untagged spend, and a waste list (unattached volumes and IPs, idle load balancers, oversized nodes, old snapshots, non-prod running 24/7) with monthly savings. `infracost` estimates changes before they ship.

## Kubernetes cost
- **OpenCost or Kubecost** when installed, read through the API server proxy (`kubectl get --raw …/services/opencost:9003/proxy/allocation/compute?window=7d&aggregate=namespace`), aggregated by namespace, controller, pod or a label such as `team`.
- **Without either:** an estimate from requests × node prices (from the bill, filtered by the cluster's tag), with **idle** capacity as its own line. Claude offers OpenCost as a GitOps change.
- **Rightsizing:** p95 usage over 7 days from Prometheus (or a `kubectl top` snapshot) vs requests; overprovisioned containers, OOM risks, nodes under 40% requested, spot candidates.
- **Join with the bill:** the gap between the cluster's bill and the allocation (control plane, load balancers, volumes, egress, NAT).

## On-prem
- **vSphere** (`govc`), **Proxmox VE** (`pvesh get`, `qm`, `pct`), **KVM** (`virsh`), **bare metal** (Ansible `setup`, `package_facts`, `service_facts`).
- **Capacity:** vCPU and memory overcommit, storage free %, N+1 headroom (can the cluster lose a host?).
- **Health:** hosts in maintenance or disconnected, HA/quorum, error events, failed backups, snapshots older than 7 days, VMs powered off for a month.
- **Patch level and end-of-life:** OS, kernel, ESXi/Proxmox and BIOS versions checked against [endoflife.date](https://endoflife.date) (only product names are sent).
- **Security quick checks:** SSH settings (with your OK), host firewalls, time sync, exposed management interfaces; `security_overview` for the clusters on top.
- **Clusters on top:** nodes matched to VMs/hosts, so findings name the clusters they affect.

## What the guard allows
Cloud CLIs: reads only; storage writes, token printing and scanners' fix modes are blocked. On-prem tools are allow-listed: `govc` info/ls/find/events/metrics (not `env`, not `vm.info -e`), `pvesh get|ls`, `qm`/`pct` list/config/status, `virsh` reads, ad-hoc `ansible` only with fact modules. `trivy k8s` must run with `--disable-node-collector`. Details and the known `ssh` limit: [SECURITY.md](https://github.com/subzone/devops-assistant/blob/main/SECURITY.md). Use read-only identities: [rbac/cloud-readonly.md](rbac/cloud-readonly.md).

## Tools
None are required; each one adds depth. Check and install them with `k8sh doctor` and `/devops-assistant:setup` (groups **cloud**, **security**, **onprem**): [Dependencies](dependencies.md).
