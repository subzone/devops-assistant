---
description: Design infrastructure + network for a system on one or more clouds, with diagrams and IaC
argument-hint: "<system and clouds, e.g. 'payments on Hetzner + AWS, EU, 99.9%'>"
---

Delegate to the `infra-architect` agent: $ARGUMENTS

Deliver:
- the design folder (README, `overview.mmd`, `network.d2`)
- validated IaC (Crossplane or Terraform/OpenTofu) with its GitOps reconciliation wiring
- the cost estimate
- a short list of open decisions

Commit to the GitOps repo and push when the user asks.
