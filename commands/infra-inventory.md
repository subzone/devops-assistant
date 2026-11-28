---
description: What runs where across clouds and on-prem, matched with your clusters — orphans, untagged, click-ops (read-only)
argument-hint: "[clouds or onprem targets] [account/project/region]"
---

Delegate to the `inventory-analyst` agent: $ARGUMENTS. If nothing is named, use the cloud CLIs that are logged in (identity calls only) plus the Kubernetes contexts.

Return:
- counts per cloud × type and per environment/owner
- orphans (with evidence), untagged %, click-ops resources not in Git
- the path of the CSV it built (in a temp directory, not the repo)
- what could not be listed and why
