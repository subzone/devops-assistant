---
description: Cloud cost report — totals, trends, top drivers, waste (read-only)
argument-hint: "[clouds] [period, default month-to-date]"
---

Delegate to the `cloud-cost-analyst` agent: $ARGUMENTS. If no clouds are named, check which CLIs are logged in (read-only identity calls such as `aws sts get-caller-identity`, `az account show`, `gcloud config list`, `hcloud context active`, `doctl account get`, `aliyun configure list`) and use those.
