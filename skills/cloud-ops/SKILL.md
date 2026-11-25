---
name: cloud-ops
description: Read-only cloud operations across AWS, Azure, GCP, Hetzner, DigitalOcean and Alibaba — query logs, inventory and costs, find cost drivers and waste. Use when the user asks about cloud logs, spend, cost breakdowns, idle resources or "what is running where".
---

# Cloud operations (read-only)

The guard allows only read calls (list/describe/get/show/query/logs/costs). It blocks mutations and commands that print tokens. Use the user's existing CLI login; never ask for keys.

## Logs
| Cloud | Command |
|---|---|
| AWS | `aws logs filter-log-events --log-group-name G --start-time <ms> --filter-pattern ERROR --max-items 100`; Insights: `aws logs start-query` + `get-query-results` |
| Azure | `az monitor log-analytics query -w <workspace-id> --analytics-query "<KQL>"` |
| GCP | `gcloud logging read 'resource.type="k8s_container" severity>=ERROR' --freshness=1h --limit 100` |
| Hetzner | no hosted log service: use the cluster's Loki via Grafana MCP |
| DigitalOcean | `doctl apps logs <app-id>`, `doctl kubernetes cluster ...` (read), otherwise Loki |
| Alibaba | `aliyun sls GetLogs --project P --logstore L --from <ts> --to <ts> --query "<q>"` |
| Kubernetes | k8sh `k8s_logs`, or Loki through Grafana MCP |

## Costs
| Cloud | Actuals | Notes |
|---|---|---|
| AWS | `aws ce get-cost-and-usage --time-period Start=YYYY-MM-01,End=YYYY-MM-DD --granularity DAILY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE` | add `Type=TAG,Key=cost-center` once tags are activated |
| Azure | `az costmanagement query --type ActualCost --timeframe MonthToDate --scope /subscriptions/<id> --dataset-grouping name=ServiceName type=Dimension` | or `az consumption usage list` |
| GCP | BigQuery billing export: `bq query --use_legacy_sql=false 'SELECT service.description, SUM(cost) ...'` | export must be enabled |
| Hetzner | `hcloud server list -o columns=name,server_type,datacenter` × the price list (`hcloud server-type list`) | no billing API; invoices in the console |
| DigitalOcean | `doctl balance get`, `doctl billing-history list`, `doctl invoice list` | |
| Alibaba | `aliyun bssopenapi QueryBillOverview --BillingCycle YYYY-MM` | |
| Pre-deploy | `infracost breakdown --path infra/live/<env>/<cloud>/<stack>` (also in `validate_manifests`) | |

## How to answer
- Fetch the data and save large results to files, then compute totals in code. Don't estimate from memory.
- Report the top cost drivers, the trend vs the previous period, and untagged spend.
- Waste checks: unattached volumes/IPs, idle LBs, oversized nodes (compare with Prometheus usage), old snapshots, non-prod running 24/7.
- Recommendations become Terraform/Crossplane changes (PR), never direct CLI changes.
