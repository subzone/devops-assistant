# Read-only identities for the analysis skills

The guard keeps Claude's CLI calls read-only, but the identity it runs as is the boundary that actually holds. Give the analysis skills (`cloud-security`, `cloud-inventory`, `cloud-ops`, `k8s-cost`, `onprem-ops`) an identity that can read and nothing else.

| Platform | Roles / policies | Covers |
|---|---|---|
| AWS | `SecurityAudit` + `ViewOnlyAccess` (managed policies); add `AWSBillingReadOnlyAccess` for Cost Explorer | security checks, inventory, costs |
| Azure | `Reader` + `Security Reader` on the subscriptions; `Cost Management Reader` for costs | security checks, Resource Graph, costs |
| GCP | `roles/viewer`, `roles/iam.securityReviewer`, `roles/securitycenter.findingsViewer`, `roles/cloudasset.viewer`; `roles/bigquery.dataViewer` on the billing export dataset | security, inventory, costs |
| Hetzner | a project API token with **Read** permission | inventory, firewalls |
| DigitalOcean | a token with read-only scope | inventory, firewalls, billing |
| Alibaba | `ReadOnlyAccess` (+ `AliyunBSSReadOnlyAccess` for bills) | security, inventory, costs |
| Kubernetes | [`agent-readonly.yaml`](agent-readonly.yaml); add `services/proxy` `get` on the OpenCost/Kubecost namespace for `k8s-cost` | everything in-cluster |
| vSphere | the built-in **Read-only** role on the vCenter root, propagated | `govc` inventory, metrics, events |
| Proxmox VE | the **PVEAuditor** role on `/` | `pvesh get`, `qm`/`pct` list/config/status |
| libvirt | a user in the libvirt group with a read-only URI (`virsh -r`) | `virsh` reads |
| Bare metal | an Ansible user without sudo for `setup`/`package_facts`/`service_facts`; `become` only where a fact needs it | facts, EOL, patch level |

Log in with these in your own terminal (`aws sso login`, `az login`, `gcloud auth login`, …). Claude never asks for or reads the keys.
