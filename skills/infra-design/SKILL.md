---
name: infra-design
description: Design cloud infrastructure and networks on AWS, Azure, GCP, Hetzner, DigitalOcean or Alibaba Cloud, and produce architecture and network diagrams as code (Mermaid/D2) reviewed against the Well-Architected pillars. Use when the user asks to design, diagram, review or compare infrastructure or networking.
---

# Infrastructure and network design

Output goes into the GitOps repo, so design, diagram and code are reviewed together:
```
docs/architecture/<system>/README.md      decisions, assumptions, WAF review, both diagrams inline
docs/architecture/<system>/overview.mmd   context/components (Mermaid)
docs/architecture/<system>/network.mmd    network: CIDRs, zones, flows (Mermaid; network.d2 only if `d2` is installed)
```

## Make it visible
The design has to be readable without extra tools:
- **Inline the diagrams in README.md** as ```` ```mermaid ```` blocks (same content as the `.mmd` files). GitHub, GitLab and VS Code's Markdown preview render them as pictures.
- If `mmdc` (Mermaid CLI) is installed, also render `overview.svg` and `network.svg` next to them; if `d2` is installed and you wrote D2, render `network.svg` with `d2 network.d2 network.svg`.
- If this session can publish a page for the user (an HTML artifact), offer to publish the design: the two diagrams rendered (Mermaid from a pinned CDN version), the WAF table, the cost estimate and the open decisions. Leave out account IDs and public IPs.
- At the end, tell the user exactly where to look: the README path, and how to preview it (GitHub, or VS Code `Markdown: Open Preview`).

## Steps
1. **Requirements:** workload, regions, environments, RTO/RPO, compliance, expected load, budget, team skills. Ask only for what changes the design.
2. **Baseline per cloud**: pick the landing-zone pattern first (accounts/subscriptions/projects, hub-spoke or single VPC).
3. **Network plan**:
   - Non-overlapping CIDRs across clouds, environments and on-prem. Reserve room for peering and VPN.
   - Subnets per tier (public / private app / private data), one per AZ/zone.
   - Egress through NAT or a firewall. Ingress through LB/WAF only.
   - Private endpoints for managed services. Name the DNS strategy.
   - Kubernetes: pod/service CIDRs don't overlap VPCs; pick the CNI mode deliberately.
4. **Diagrams**: overview plus network. Label every edge with protocol and port, and mark trust boundaries.
5. **WAF review**: one line per pillar (operational excellence, security, reliability, performance, cost, sustainability), with the main risk and its mitigation.
6. **Hand off to code**: Crossplane (`iac-crossplane`) for continuously reconciled resources on AWS/Azure/GCP, Terraform/OpenTofu (`iac-terraform`) elsewhere or when the team prefers it.

## Service map
| Need | AWS | Azure | GCP | Hetzner | DigitalOcean | Alibaba |
|---|---|---|---|---|---|---|
| Network | VPC | VNet | VPC (global) | Network + subnets | VPC | VPC + vSwitch |
| Kubernetes | EKS | AKS | GKE | k3s/Talos/kubeadm on Cloud servers (Ansible) | DOKS | ACK |
| LB | ALB/NLB | App GW / LB | Cloud LB | Load Balancer | Load Balancer | SLB/ALB |
| Firewall | SG + NACL / Network Firewall | NSG / Azure Firewall | VPC firewall rules | Firewalls | Cloud Firewalls | Security groups |
| Private DNS | Route 53 private | Private DNS zones | Cloud DNS private | (self-managed) | (self-managed) | PrivateZone |
| Object storage | S3 | Blob | GCS | Object Storage (S3 API) | Spaces (S3 API) | OSS |
| Managed DB | RDS/Aurora | Azure DB | Cloud SQL | (self-managed) | Managed DB | ApsaraDB RDS |
| Secrets | Secrets Manager | Key Vault | Secret Manager | (Vault) | (Vault) | KMS Secrets Manager |
| Logs | CloudWatch | Log Analytics | Cloud Logging | (Loki) | (Loki) | SLS |
| Cost data | Cost Explorer / CUR | Cost Management | Billing export (BigQuery) | invoices | billing API | BSS OpenAPI |

## Diagram templates
```mermaid
flowchart LR
  user((Users)) -->|HTTPS 443| waf[WAF/LB]
  subgraph vpc[VPC 10.20.0.0/16]
    subgraph pub[public 10.20.0.0/20]
      waf
    end
    subgraph app[private-app 10.20.16.0/20]
      k8s[Kubernetes nodes]
    end
    subgraph data[private-data 10.20.32.0/20]
      db[(Managed DB)]
    end
  end
  waf -->|HTTP 8080| k8s
  k8s -->|TLS 5432| db
  k8s -->|egress via NAT| internet((Internet))
```
D2 suits larger network maps (`vpc: {pub: {...}; app: {...}}` with `app.k8s -> data.db: "5432/TLS"`) but needs the `d2` CLI to render; default to Mermaid.

Reviewing an existing environment instead of designing a new one: build the picture from `cloud-inventory` (and `onprem-ops`) output first, then run the same WAF review on what exists, with `cloud-security` findings in the security line and `cloud-ops`/`k8s-cost` numbers in the cost line.

Rules: no credentials, account IDs or public IPs of prod systems in diagrams unless the user asks.
