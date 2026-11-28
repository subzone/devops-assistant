---
name: cloud-inventory
description: Read-only inventory of what runs where across AWS, Azure, GCP, Hetzner, DigitalOcean and Alibaba, normalised into one table and matched against the Kubernetes clusters (nodes, load balancers, volumes) to find orphans, untagged resources and drift from Git. Use when the user asks "what is running where", for an inventory, asset list, orphaned or forgotten resources, or tagging coverage.
---

# Cloud inventory (read-only)

Use the user's existing CLI login; only list/describe/search calls. Raw output goes to a temp directory outside the repo (`mktemp -d`), then a script builds the table. Don't count by hand.

## 1. Collect
| Cloud | Everything at once | Per type (when the broad call is off or incomplete) |
|---|---|---|
| AWS | `aws resource-explorer-2 search --query-string "*" --max-results 1000` (needs Resource Explorer on); else `aws resourcegroupstaggingapi get-resources` per region (tagged resources only) | `aws ec2 describe-instances`, `describe-volumes`, `describe-addresses`, `aws elbv2 describe-load-balancers`, `aws eks list-clusters`, `aws rds describe-db-instances`, `aws s3api list-buckets`, `aws lambda list-functions` |
| Azure | Resource Graph, see below the table | `az resource list`, `az vm list -d`, `az disk list`, `az network public-ip list`, `az network lb list`, `az aks list` |
| GCP | `gcloud asset search-all-resources --scope=projects/P --format=json` (or `organizations/ORG`; needs the Cloud Asset API) | `gcloud compute instances list`, `disks list`, `addresses list`, `forwarding-rules list`, `gcloud container clusters list`, `gcloud sql instances list`, `gcloud storage buckets list` |
| Hetzner | — | `hcloud server list -o json`, `volume list`, `load-balancer list`, `primary-ip list`, `floating-ip list`, `network list`, `firewall list` |
| DigitalOcean | — | `doctl compute droplet list -o json`, `volume list`, `load-balancer list`, `reserved-ip list`, `doctl kubernetes cluster list`, `doctl databases list`, `doctl apps list` |
| Alibaba | `aliyun resourcecenter SearchResources` (needs Resource Center on) | `aliyun ecs DescribeInstances --RegionId R`, `DescribeDisks`, `aliyun slb DescribeLoadBalancers`, `aliyun cs GET /clusters` |

Azure Resource Graph (the user installs the `resource-graph` CLI extension once, themselves):
```
az graph query -q "Resources | project subscriptionId, resourceGroup, type, name, location, sku, tags" --first 1000
```

Cover every region the account uses (`aws ec2 describe-regions`, `az account list-locations` only if needed, `gcloud compute regions list`); say which regions were skipped.

## 2. Normalise
One row per resource: `cloud, account, region, type, name, id, size/sku, state, created, owner, env, cost-center, cluster, managed-by`. Read `owner`/`env`/`cost-center`/`managed-by` from tags or labels (common keys: `owner`, `team`, `env`, `environment`, `cost-center`, `managed-by`, `terraform`, `crossplane.io/*`, `argocd.argoproj.io/*`). Save it as CSV in the temp directory; show the summary in chat.

## 3. Match with Kubernetes
k8sh `k8s_contexts`, `fleet_status`, and `k8s_get` for nodes, Services of type LoadBalancer and PersistentVolumes per context.
- **Nodes ↔ instances** by `spec.providerID`: `aws:///<zone>/i-…`, `azure:///subscriptions/…/virtualMachines/…`, `gce://<project>/<zone>/<name>`, `hcloud://<id>`, `digitalocean://<id>`, `<region>.<instance-id>` (Alibaba). Instances tagged as cluster nodes (`kubernetes.io/cluster/<name>`, `eks:cluster-name`, AKS `MC_<rg>_<cluster>_<region>` resource group, GKE `goog-k8s-cluster-name`, DOKS `k8s:<cluster-id>`) with no matching node are **orphans**.
- **Load balancers ↔ Services** by the Service's `status.loadBalancer.ingress` hostname/IP. A cloud LB nobody points at is an orphan.
- **Volumes ↔ PVs** by `spec.csi.volumeHandle`. Unattached volumes with no PV are orphans (and cost money).

## 4. Match with Git (when a GitOps/IaC repo is at hand)
Resources with no `managed-by` tag and no match in the repo's Terraform/Crossplane are **click-ops**: candidates for import into code (`terraform import` blocks or Crossplane `managementPolicies: ["Observe"]`), proposed as a PR, never run here.

## 5. Report
- Counts per cloud × type, and per environment/owner.
- **Orphans** (with the evidence of why), **untagged** (% per cloud, missing keys), **click-ops** list, **oldest** running non-prod resources.
- What could not be listed (permissions, disabled APIs, regions).
- Hand cost questions to `cloud-ops` and security questions to `cloud-security`. Cleanup is a PR that removes the resource from code; the lock covers anything destructive.
