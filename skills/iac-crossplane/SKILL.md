---
name: iac-crossplane
description: Model cloud infrastructure as Crossplane managed resources and compositions, reconciled by Argo CD, for AWS, Azure, GCP and (via provider-terraform or community providers) Hetzner, DigitalOcean and Alibaba. Use when generating Crossplane providers, ProviderConfigs, XRDs, Compositions or managed resources.
---

# Crossplane

Argo CD syncs Crossplane objects from Git, and Crossplane reconciles the cloud continuously. Drift is corrected automatically.

## Providers
| Cloud | Provider | Notes |
|---|---|---|
| AWS | `xpkg.upbound.io/upbound/provider-aws-<service>` (family) | install only the services you use; IRSA / Pod Identity auth |
| Azure | `xpkg.upbound.io/upbound/provider-azure-<service>` | Workload Identity |
| GCP | `xpkg.upbound.io/upbound/provider-gcp-<service>` | Workload Identity |
| DigitalOcean | crossplane-contrib DigitalOcean provider | check maturity and coverage first |
| Hetzner, Alibaba | `provider-terraform` wrapping `hcloud` / `alicloud` modules | community providers exist, but verify they're maintained before relying on them |

Check current package versions in the Upbound Marketplace before pinning. Crossplane v2 changed composition (namespaced XRs, claims de-emphasised), so match the cluster's version: `kubectl get deploy -n crossplane-system crossplane -o jsonpath='{..image}'`.

## Repo layout
```
platform/crossplane/providers/        Provider + DeploymentRuntimeConfig per family
platform/crossplane/providerconfigs/  ProviderConfig per cloud/account (keyless)
platform/crossplane/apis/<name>/      XRD + Composition(s) (+ functions)
apps/<team>/infra/                    XRs / managed resources consumed by teams
```
Argo CD sync waves: providers (-3) → providerconfigs (-2) → XRDs/compositions (-1) → XRs (0).

## Safety defaults
- `deletionPolicy: Orphan` (or `managementPolicies` without `Delete`) on stateful and prod resources. Otherwise removing YAML from Git deletes the cloud resource.
- Argo CD `prune: false` for infra apps, so pruning needs a user grant (`sync-prune`).
- ProviderConfig auth through IRSA / Workload Identity. If a secret is unavoidable, the ExternalSecret creates it; never put it in Git.
- Labels: `owner`, `env`, `cost-center`, `managed-by=crossplane`.

## Before proposing a PR
Run `validate_manifests` on the directory. It renders, scans for secrets, validates schemas, runs `crossplane beta validate` when installed, and warns about missing `deletionPolicy: Orphan` and static-secret ProviderConfigs.
