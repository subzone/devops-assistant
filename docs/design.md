# Infrastructure design

`/devops-assistant:infra-design "<system, clouds, needs>"` turns requirements into a reviewed design and the code that builds it. It never applies anything.

```
/devops-assistant:infra-design "shop API on AWS eu-central-1 + Hetzner for batch, EU data, 99.9%, ~€2k/month"
```

## What happens
The `infra-architect` agent follows the `infra-design` skill, then `iac-crossplane` or `iac-terraform`:

1. **Requirements:** asks only what changes the design — regions, environments, RTO/RPO, compliance, load, budget, team skills.
2. **Baseline per cloud:** the landing-zone pattern first (accounts/subscriptions/projects, hub-spoke or single VPC).
3. **Network plan:** non-overlapping CIDRs across clouds, environments and on-prem; subnets per tier and zone; egress through NAT or a firewall; ingress only through a load balancer/WAF; private endpoints; DNS; pod/service CIDRs that don't collide.
4. **Diagrams:** a component overview and a network map, every edge labelled with protocol and port, trust boundaries marked.
5. **Well-Architected review:** one line per pillar (operational excellence, security, reliability, performance, cost, sustainability) with the main risk and its mitigation.
6. **Code:** Crossplane for continuously reconciled AWS/Azure/GCP resources, Terraform/OpenTofu elsewhere (reconciled by Crossplane `provider-terraform` or an Argo Workflows plan → approve → apply pipeline). Keyless auth, remote state, tags, `prevent_destroy` on stateful resources, no secrets in code.
7. **Validation:** `validate_manifests` on every stack until required stages pass — secret scan, fmt, validate, tflint, trivy, checkov — plus an `infracost` estimate.
8. **Summary:** what gets created, the monthly cost, anything destructive, the PR to open, and where to look.

## What you get
```
docs/architecture/<system>/README.md      decisions, assumptions, WAF review, both diagrams inline
docs/architecture/<system>/overview.mmd   components (Mermaid)
docs/architecture/<system>/network.mmd    network: CIDRs, zones, flows (Mermaid)
infra/live/<env>/<cloud>/<stack>/         Terraform/OpenTofu, or Crossplane manifests under platform/
```
It's written into the repository you're working in, on a branch, and committed or pushed only when you ask.

## Where to see it
- **On GitHub or GitLab:** open `docs/architecture/<system>/README.md`; the Mermaid diagrams render as pictures.
- **In VS Code:** open the README and run `Markdown: Open Preview` (⇧⌘V).
- **As SVGs:** with `mmdc` (Mermaid CLI) or `d2` installed (`k8sh doctor --group design`), Claude renders `overview.svg` and `network.svg` next to the sources.
- **As a page:** when your session can publish an HTML page, Claude offers one with the rendered diagrams, the WAF table, the cost estimate and the open decisions (account IDs and public IPs left out).

## Reviewing what already exists
Ask for a review instead of a new design ("review our AWS and Hetzner setup against Well-Architected"). Claude builds the picture from the [inventory](analysis.md#inventory) (and on-prem) analysis, then runs the same WAF review with the [security](analysis.md#security-overview) findings in the security line and the [cost](analysis.md#cloud-cost) numbers in the cost line.

## Clouds
| Need | AWS | Azure | GCP | Hetzner | DigitalOcean | Alibaba |
|---|---|---|---|---|---|---|
| Network | VPC | VNet | VPC | Network | VPC | VPC + vSwitch |
| Kubernetes | EKS | AKS | GKE | k3s/Talos/kubeadm (Ansible) | DOKS | ACK |
| IaC | Crossplane or Terraform | Crossplane or Terraform | Crossplane or Terraform | Terraform (`hcloud`) | Terraform | Terraform |

The full service map is in `skills/infra-design/SKILL.md`.
