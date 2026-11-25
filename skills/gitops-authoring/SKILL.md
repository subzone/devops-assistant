---
name: gitops-authoring
description: How to author GitOps changes for Argo CD with Kustomize or Helm — repo layout, overlays, ExternalSecrets, Argo CD Application and AppProject templates. Use when creating or changing manifests, charts, overlays or Argo CD apps.
---

# GitOps authoring

## Repo layout (default; follow the repo's existing one if it differs)
```
apps/<app>/base/                 kustomization.yaml, deployment.yaml, service.yaml, externalsecret.yaml
apps/<app>/overlays/<env>/       kustomization.yaml (patches, images, replicas)
clusters/<cluster>/              app-of-apps: Application/ApplicationSet per app
platform/<component>/            ingress, cert-manager, external-secrets, kyverno, monitoring
policies/                        Kyverno policies (used by validate_manifests)
```

## Workload defaults
- Pin images by tag + digest where possible. Never `:latest`.
- `resources.requests` and `limits` (memory limit always; CPU limit optional).
- `securityContext`: `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`, `seccompProfile.type: RuntimeDefault`.
- Readiness and liveness probes; `PodDisruptionBudget` and `topologySpreadConstraints` for ≥2 replicas.

## Secrets — ExternalSecret only
```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: <app>-db
spec:
  refreshInterval: 1h
  secretStoreRef: {kind: ClusterSecretStore, name: <store>}
  target: {name: <app>-db}
  data:
    - secretKey: password
      remoteRef: {key: <path/in/store>, property: password}
```
Consume it with `envFrom.secretRef` or `env.valueFrom.secretKeyRef`. Never inline values.

## Argo CD Application (prune off by default)
```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: <app>-<env>
  namespace: argocd
spec:
  project: <project>
  source: {repoURL: <repo>, targetRevision: main, path: apps/<app>/overlays/<env>}
  destination: {name: <cluster>, namespace: <ns>}
  syncPolicy:
    automated: {prune: false, selfHeal: true}
    syncOptions: [CreateNamespace=false, PrunePropagationPolicy=foreground]
```
Prune stays `false`: removing resources needs a user grant (`sync-prune`).

## Flow
branch → edit → `validate_manifests` (fix until required stages pass) → show diff (flag deletions) → commit → ask before push/PR.
