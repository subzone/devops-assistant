# Security model

k8s-handler has two rules that no setting turns off:

1. **No destructive action without an explicit user command at that moment.**
2. **No credentials in Git, and none exposed to the model, logs or UI.**

## Destructive-action lock

| Layer | What it does | Where |
|---|---|---|
| MCP tools | `destructive_*` tools refuse without a matching grant and consume it on use. Each attempt is audited. | `internal/mcp/tools.go` |
| Grants | Single use, exact scope (context + namespace + action + `kind/name`, no wildcards), max 15 min, HMAC-signed. Issued only after the user types the context name: by `k8sh unlock` from a controlling terminal (refused when `CLAUDECODE`/`K8SH_AGENT` is set), or from the k8s pane (below). | `internal/grant` |
| k8s pane unlock | The pane's `Unlock…` is a mod Button and Input: only the person can press or type into them, and no tool, command or prompt leads there. On submit the pane checks the typed text equals the context, then runs `k8sh grant-from-ui`, which checks it again, requires the UI token on stdin (`~/.k8sh/ui.token`, 0600, rotated after every grant), allows only delete for pods/daemonsets and delete or scale-zero for deployments/statefulsets, refuses the MCP server's environment (`K8SH_AGENT`), and writes the audit log (`source: ui`). The guard blocks `k8sh … grant` and `ui.token` in Bash and `~/.k8sh` everywhere. | `hooks/k8s-pane.js`, `cmd/k8sh`, `internal/grant/ui.go` |
| PreToolUse hook | Blocks destructive `kubectl`/`helm`/`argocd`/`ansible`/`velero`/cloud-CLI/`terraform` commands, force-push, `k8sh unlock`, access to `~/.k8sh`, and pseudo-terminal tools. Fails closed on bad input and when the binary is missing. | `internal/guard`, `hooks/hooks.json`, `bin/k8sh-launch` |
| Keystroke injection | The hook blocks `tmux send-keys`/`paste-buffer`, `wezterm cli send-text`, `kitty @ send-text`, `xdotool`/`ydotool`/`wtype` and `osascript` keystrokes, so Claude can't type a confirmation into your terminal or the TUI. | `internal/guard` |
| Kubernetes RBAC | The agent identity should be read-only: `docs/rbac/agent-readonly.yaml`. | your cluster |
| Argo CD | `automated.prune: false` by default, so pruning needs a `sync-prune` grant. | `skills/gitops-authoring` |

### Known limit (v0.1)
Grants and the HMAC key are stored in `~/.k8sh` and owned by your OS user. The hook and the deny-list stop the agent from touching them, but a process running **as your user** outside Claude's tools could in principle forge a grant. Hard isolation is on the roadmap: a k8sh daemon running as a separate OS user, holding grants in memory, with peer-credential checks on its socket. Until then, read-only cluster RBAC for the agent identity is the boundary that actually holds. Use it.

The k8s pane's unlock has the same same-user limit. `k8sh grant-from-ui` can't tell the pane apart from any other process of your user that holds the UI token: the token, the guard rules and the absence of any agent route to the pane's Button and Input are what keep Claude out. A command that slips past the guard's patterns (a renamed copy of the binary, say, together with an obfuscated read of `~/.k8sh/ui.token`) could issue a grant. Rotation after each grant limits how long a token that leaked stays useful. The separate-user daemon on the roadmap closes this gap too.

### Differences from the design plan
- `/k8s-handler:unlock` only **prints** the command. You run `k8sh unlock` yourself in a separate terminal. Chat input can't be trusted as a confirmation channel.
- Claude Desktop elicitation-based confirmation is on the roadmap.

### Local configuration is not locked
`k8sh config` (tiers, TTL ceiling 1-15 min) and `k8sh settings apply` (add-only deny rules + status line) can be run by Claude. Neither can weaken the lock: tiers never relax it, the TTL ceiling can't exceed 15 minutes, and settings merge only adds rules. Direct file access to `~/.k8sh` (grants, signing key, audit log) stays blocked.

## Credentials
- **Redaction** (`internal/redact`) runs on every value k8sh returns and on the audit log: Secret `data`/`stringData` (keys stay visible), `last-applied-configuration`, sensitive env values, and token patterns (JWT, AWS, GitHub, Slack, Grafana, PEM, URL credentials, Authorization headers, key=value pairs).
- **Blocked reads:** `kubectl get secret -o …`, `config view --raw`, `base64 -d`, env dumps, and `~/.kube`, `~/.aws`, `~/.azure`, gcloud config, `.env`, `*.pem|key|p12`.
- **Blocked writes:** the hook refuses `Secret` manifests that contain `data`/`stringData`. Use `ExternalSecret`.
- **Validation:** a required secret-scan stage (builtin, plus gitleaks when installed), and the same in CI.
- **Cluster auth:** use exec plugins (EKS/AKS/GKE/OIDC). k8sh never reads kubeconfig itself; it shells out to `kubectl`.
- **MCP credentials** (Grafana, Prometheus, Git host) come from env or keychain, never from repo files (`docs/observability.md`).

## Reporting
Open a private security advisory on GitHub.
