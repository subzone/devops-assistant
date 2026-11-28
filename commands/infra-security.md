---
description: Security overview of cloud accounts, clusters or on-prem — exposure, identities, keys, encryption, logging (read-only)
argument-hint: "[aws|azure|gcp|hetzner|do|alibaba|k8s|onprem ...] [account/project/context]"
---

Delegate to the `security-auditor` agent: $ARGUMENTS. If nothing is named, check which cloud CLIs are logged in (identity calls only) and which Kubernetes contexts exist, then cover those.

Return:
- the scope covered and the scanner or checks used
- findings worst first: severity, check, where, why it matters, fix as code
- counts per severity and per cloud/cluster
- what could not be checked and why
- an offer to open the fixes as PRs via `/devops-assistant:deploy`
