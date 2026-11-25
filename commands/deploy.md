---
description: Make a change the GitOps way — edit repo, validate, open a PR. Never applies to the cluster.
argument-hint: "<what to change>"
---

Implement this change through GitOps: $ARGUMENTS

Follow the `gitops-authoring` skill:

1. Find the owning Argo CD app (`argo_apps` / `argo_app_tree`) and its repo path. Confirm you are working in that repo.
2. Create a branch `k8sh/<short-slug>`.
3. Edit only the files the change needs (base vs overlay as appropriate). Secrets are `ExternalSecret`s only.
4. Run `validate_manifests` on the changed overlay/chart (with `context` for server dry-run when a non-prod context is available). Fix until all required stages pass.
5. Show the diff. Call out anything that would delete or prune resources. That needs a user grant at sync time.
6. Commit, then ask the user before pushing and opening the PR (`gh pr create` or the repo's host CLI).

Never run `kubectl apply`, `helm install/upgrade` or `argocd app sync` against a cluster.
