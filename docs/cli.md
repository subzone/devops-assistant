# k8sh CLI reference

`k8sh` is the plugin's core: the MCP server, the guard hook, the lock, validation and the standalone TUI. Inside Claude Code it runs through `bin/k8sh-launch`; for your own terminal see [Getting started](getting-started.md#optional-k8sh-on-your-path).

## Lock (you run these)
| Command | |
|---|---|
| `k8sh unlock --context C --action A --target kind/name [--namespace N] [--ttl 10m]` | issue a single-use grant; asks you to type the context name; refused when run by an agent |
| `k8sh grants` | active grants with expiry |
| `k8sh actions` | actions that need a grant |
| `k8sh lock` | revoke every grant |
| `k8sh audit [--tail N]` | the redacted audit log |

## Setup and configuration
| Command | |
|---|---|
| `k8sh doctor [--group G,..] [--plan] [--json]` | which tools each feature can use and how to install the missing ones (looks only) — [Dependencies](dependencies.md) |
| `k8sh config show` | context tiers and the grant TTL ceiling |
| `k8sh config set-tier CONTEXT dev\|staging\|prod` | label a context (unlabelled = prod) |
| `k8sh config set-ttl MINUTES` | grant TTL ceiling, 1–15 |
| `k8sh settings apply [--path P] [--statusline CMD] [--force-statusline] [--dry-run]` | add-only merge of deny rules and the status line into Claude settings, `.bak` kept |
| `k8sh statusline` | the one-line status for Claude Code's status line |
| `k8sh version` | |

## Work
| Command | |
|---|---|
| `k8sh validate PATH [--strict] [--context C] [--json]` | the validation pipeline ([GitOps](gitops.md)) |
| `k8sh tui` | standalone terminal UI (Cluster, Argo CD, RCA, Lock) |
| `k8sh tui --open` | open it in a new tmux/WezTerm/kitty pane or terminal window |
| `k8sh workspace [claude args]` | Claude on the left, the TUI on the right (tmux) |

## Used by the plugin
| Command | |
|---|---|
| `k8sh mcp` | the MCP server on stdio |
| `k8sh hook pretooluse` | the PreToolUse guard (JSON on stdin) |
| `k8sh grant-from-ui …` | the pane's unlock (UI token on stdin; user-confirmed only) |
| `k8sh ui-init` | create the pane's UI token |

## Environment
| Variable | |
|---|---|
| `K8SH_HOME` | state directory (default `~/.k8sh`: config, grants, signing key, audit log, RCA history, incidents) |
| `K8SH_NO_DOWNLOAD=1` | the launcher never downloads a release binary |
