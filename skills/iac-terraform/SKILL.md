---
name: iac-terraform
description: Write Terraform/OpenTofu for AWS, Azure, GCP, Hetzner, DigitalOcean and Alibaba Cloud with remote state, keyless auth and GitOps-driven apply (Crossplane provider-terraform or an Argo Workflows plan/approve/apply pipeline). Use when generating or changing Terraform/OpenTofu code.
---

# Terraform / OpenTofu

You never run `apply`, `destroy`, `import` or `state` mutations; the guard blocks them. Code goes through PR → merge → reconciliation. `plan` is fine where the user's credentials allow it.

## Layout
```
infra/modules/<name>/            main.tf variables.tf outputs.tf versions.tf README.md
infra/live/<env>/<cloud>/<stack>/ backend.tf providers.tf main.tf (calls modules) terraform.tfvars (no secrets)
```

## Providers, keyless auth, state
| Cloud | Provider source | Auth in CI/cluster (no static keys) | Remote state + locking |
|---|---|---|---|
| AWS | `hashicorp/aws` | OIDC → IAM role; IRSA/Pod Identity in-cluster | `s3` + `use_lockfile = true` |
| Azure | `hashicorp/azurerm` | OIDC federated credential / Workload Identity (`use_oidc = true`) | `azurerm` (blob lease) |
| GCP | `hashicorp/google` | Workload Identity Federation / GKE Workload Identity | `gcs` |
| Hetzner | `hetznercloud/hcloud` | `HCLOUD_TOKEN` from a secret store (ExternalSecret), never in code | `s3` on Hetzner Object Storage + `use_lockfile` |
| DigitalOcean | `digitalocean/digitalocean` | `DIGITALOCEAN_TOKEN` from a secret store | `s3` on Spaces + `use_lockfile` |
| Alibaba | `aliyun/alicloud` | RAM role / OIDC (RRSA on ACK) | `oss` (+ Tablestore lock) |

Always: `required_version`, a pinned `required_providers`, `default_tags`/labels (`owner`, `env`, `cost-center`, `managed-by=terraform`), `lifecycle { prevent_destroy = true }` on stateful resources, and no secrets in `.tf`/`.tfvars` (use data sources from the secret manager).

## GitOps reconciliation (pick one per stack)
1. **Crossplane `provider-terraform`** (continuous, Argo CD-native). A `Workspace` CR points at the module in Git, and Argo CD syncs it like any manifest. Use `deletionPolicy: Orphan` for prod.
   ```yaml
   apiVersion: tf.upbound.io/v1beta1
   kind: Workspace
   metadata: {name: hetzner-prod-network}
   spec:
     deletionPolicy: Orphan
     forProvider:
       source: Remote
       module: git::https://github.com/<org>/<repo>.git//infra/live/prod/hetzner/network?ref=main
     providerConfigRef: {name: hetzner}
   ```
2. **Argo Workflows plan → approve → apply** (explicit gate). Trigger on merge: `init` → `plan -out` → if the plan has deletes or replaces, a `suspend` step waits for human approval → `apply plan`. Credentials come from workload identity / ExternalSecret.

## Before proposing a PR
Run `validate_manifests` on the stack dir. It runs builtin secret and hygiene checks, gitleaks, `fmt`, `init -backend=false` + `validate`, tflint, trivy, checkov and an infracost estimate. Show the cost estimate and flag every destroy/replace.
