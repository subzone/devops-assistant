---
description: Run the validation pipeline on manifests, a kustomize overlay or a Helm chart
argument-hint: "<path> [context for server dry-run]"
---

Validate `$ARGUMENTS` with the k8sh `validate_manifests` tool. If a second argument is given, pass it as `context` to include the server-side dry-run.

Report each stage as ✔ / ✖ / · (skipped). For every ✖, give the exact finding and a concrete fix. If a required stage fails, say clearly that the change **must not** be proposed as a PR yet.

If the secrets stage fails, replace the offending values with an `ExternalSecret` (see the `gitops-authoring` skill). Never print the secret value.
