# GitOps and validation

Every change to a cluster or a cloud goes **Git → PR → Argo CD (or the IaC pipeline)**. Claude never runs `kubectl apply`, `helm install/upgrade`, `argocd app sync`, `terraform apply` or a mutating cloud CLI call; the guard blocks them.

## Making a change
```
/devops-assistant:deploy "raise payments/api memory limit to 512Mi in prod"
```
1. Finds the owning Argo CD app (`argo_apps`, `argo_app_tree`) and its repo path, and checks you're in that repo.
2. Creates a branch `k8sh/<slug>`.
3. Edits only what the change needs (base vs overlay), following `gitops-authoring`: pinned images, requests and limits, a restrictive `securityContext`, probes, PDBs; secrets only as `ExternalSecret`.
4. Runs `validate_manifests` (with a server-side dry-run on a non-prod context when there is one) until required stages pass.
5. Shows the diff and calls out anything that deletes or prunes. That needs a grant at sync time.
6. Commits, then asks before pushing and opening the PR.

RCA, analysis and design results come back the same way: as a file and a diff for this flow.

## The validation pipeline
`validate_manifests` (MCP), `/devops-assistant:validate <path> [context]`, or `k8sh validate <path>` detects what it's looking at:

| Input | Stages |
|---|---|
| Kubernetes (plain, Kustomize, Helm, incl. Crossplane objects) | render → secret scan (builtin + gitleaks) → schema (kubeconform) → lint (kube-linter) → policy (Kyverno, when `policies/` exists) → security (trivy) → `crossplane beta validate` and `deletionPolicy` checks → optional server dry-run |
| Terraform / OpenTofu | secret scan → `fmt` → `init -backend=false` + `validate` → tflint → trivy → checkov → infracost estimate |

A stage whose tool is missing is *skipped* (see [Dependencies](dependencies.md)); required stages must pass before a PR is proposed.

## CI
```bash
k8sh validate apps/payments/overlays/prod --strict
```
Exits 1 when a required stage fails. With `--strict`, missing scanners count as failures. This repository's own CI (`.github/workflows/ci.yml`) runs gofmt, vet, race tests, a cross-compile and gitleaks.

## Infrastructure reconciliation
- **Crossplane** objects are synced by Argo CD like any manifest (AWS, Azure, GCP providers; `provider-terraform` `Workspace`s for Hetzner, DigitalOcean, Alibaba or existing modules). `deletionPolicy: Orphan` for prod.
- **Argo Workflows plan → approve → apply:** on merge, `init` → `plan -out`; if the plan has deletes or replaces, a suspend step waits for human approval; then `apply` of that plan.
- Credentials come from workload identity / OIDC or `ExternalSecret`, never from the repo.

## Destructive steps
Pruning, deleting, scaling to zero, rollbacks and the like are locked. Claude shows the exact `k8sh unlock …` command, you run it in your own terminal (or use **Unlock…** in the pane), and the grant allows that one action once. See [SECURITY.md](../SECURITY.md).
