# Prometheus and Grafana MCP

k8sh doesn't reimplement metrics access. It works next to existing MCP servers, and Claude's agents combine all three.

## Grafana MCP (recommended)
[grafana/mcp-grafana](https://github.com/grafana/mcp-grafana) covers dashboards, Prometheus and Loki queries, alerts and incidents.

Add it to your user or project MCP config, **not** to this repo:

```bash
# token lives in your shell env or keychain, never in a file in Git
export GRAFANA_URL=https://grafana.example.com
export GRAFANA_SERVICE_ACCOUNT_TOKEN="$(security find-generic-password -s grafana-mcp -w)"   # macOS keychain example
claude mcp add grafana --scope user -e GRAFANA_URL -e GRAFANA_SERVICE_ACCOUNT_TOKEN -- mcp-grafana
```

Use a **Viewer** service account. The agent needs no write access to Grafana.

## Prometheus MCP (where Grafana isn't available)
Any Prometheus MCP server that exposes PromQL query and range-query tools works. Register it the same way, with credentials from env or keychain.

## How the plugin uses them
| Use | Example |
|---|---|
| RCA | restarts, memory vs limit, 5xx ratio, Loki error logs around the incident |
| Capacity (roadmap) | requests vs usage, headroom per node pool |
| Chaos (roadmap) | steady-state SLO query + abort condition |
| Live verification (roadmap) | SLO before/after a sync |
