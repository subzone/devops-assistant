# Security model

k8s-handler has two rules that no setting turns off:

1. **No destructive action without an explicit user command at that moment.**
2. **No credentials in Git, and none exposed to the model, logs or UI.**

## Destructive-action lock

| Layer | What it does | Where |
|---|---|---|
| MCP tools | `destructive_*` tools refuse without a matching grant and consume it on use. Each attempt is audited. | `internal/mcp/tools.go` |
| Grants | Single use, exact scope (context + namespace + action + `kind/name`, no wildcards), max 15 min, HMAC-signed. Issued only by `k8sh unlock` from a controlling terminal, after the user types the context name. Refused when `CLAUDECODE`/`K8SH_AGENT` is set. | `internal/grant` |
| PreToolUse hook | Blocks destructive `kubectl`/`helm`/`argocd`/`ansible`/`velero`/cloud-CLI/`terraform` commands, force-push, `k8sh unlock`, access to `~/.k8sh`, and pseudo-terminal tools. Fails closed on bad input and when the binary is missing. | `internal/guard`, `hooks/hooks.json`, `bin/k8sh-launch` |
| Kubernetes RBAC | The agent identity should be read-only: `docs/rbac/agent-readonly.yaml`. | your cluster |
| Argo CD | `automated.prune: false` by default, so pruning needs a `sync-prune` grant. | `skills/gitops-authoring` |

### Known limit (v0.1)
Grants and the HMAC key are stored in `~/.k8sh` and owned by your OS user. The hook and the deny-list stop the agent from touching them, but a process running **as your user** outside Claude's tools could in principle forge a grant. Hard isolation is on the roadmap: a k8sh daemon running as a separate OS user, holding grants in memory, with peer-credential checks on its socket. Until then, read-only cluster RBAC for the agent identity is the boundary that actually holds. Use it.

### Differences from the design plan
- `/k8s-handler:unlock` only **prints** the command. You run `k8sh unlock` yourself in a separate terminal. Chat input can't be trusted as a confirmation channel.
- Claude Desktop elicitation-based confirmation is on the roadmap.

## Credentials
- **Redaction** (`internal/redact`) runs on every value k8sh returns and on the audit log: Secret `data`/`stringData` (keys stay visible), `last-applied-configuration`, sensitive env values, and token patterns (JWT, AWS, GitHub, Slack, Grafana, PEM, URL credentials, Authorization headers, key=value pairs).
- **Blocked reads:** `kubectl get secret -o …`, `config view --raw`, `base64 -d`, env dumps, and `~/.kube`, `~/.aws`, `~/.azure`, gcloud config, `.env`, `*.pem|key|p12`.
- **Blocked writes:** the hook refuses `Secret` manifests that contain `data`/`stringData`. Use `ExternalSecret`.
- **Validation:** a required secret-scan stage (builtin, plus gitleaks when installed), and the same in CI.
- **Cluster auth:** use exec plugins (EKS/AKS/GKE/OIDC). k8sh never reads kubeconfig itself; it shells out to `kubectl`.
- **MCP credentials** (Grafana, Prometheus, Git host) come from env or keychain, never from repo files (`docs/observability.md`).

## Reporting
Open a private security advisory on GitHub.
