# Getting started

## 1. Install the plugin

In Claude Code:
```
/plugin marketplace add subzone/devops-assistant
/plugin install devops-assistant@subzone
```
Restart Claude Code (or start a new session) so the MCP server, the guard hook and the k8s pane load.

## 2. Run setup
```
/devops-assistant:setup
```
Claude walks through these steps and asks before it writes or installs anything:

1. **The `k8sh` binary.** `bin/k8sh-launch` finds it in this order:
   1. a release binary in the plugin (`bin/k8sh-<os>-<arch>`);
   2. in a source checkout with Go 1.24+: a build from source, rebuilt when the code changes;
   3. `bin/k8sh`;
   4. **the release binary for this plugin version, downloaded from GitHub Releases and installed only if its SHA256 matches the release's `SHA256SUMS`** (set `K8SH_NO_DOWNLOAD=1` to turn this off);
   5. `k8sh` on your `PATH`.

   The guard hook never downloads (it has a 10-second budget); until a binary exists it **fails closed** for Kubernetes and credential commands.
2. **Tools.** `k8sh doctor` lists what each feature can use. You pick the groups you want in one question, Claude shows the exact install commands, and runs them one at a time after you confirm. `sudo` lines are yours to run (`! sudo …`). See [Dependencies](dependencies.md).
3. **Context tiers** (dev / staging / prod). Contexts you don't label count as prod. Tiers are labels; destructive actions stay locked on every tier.
4. **Claude settings:** an add-only merge of deny-list rules and the k8sh status line into `~/.claude/settings.json` (a `.bak` is kept).
5. **Observability** (optional): Grafana MCP ([guide](observability.md)).
6. **Read-only identities:** [Kubernetes RBAC](rbac/agent-readonly.yaml), [clouds and on-prem](rbac/cloud-readonly.md).

## 3. First steps

| Try | What happens |
|---|---|
| `/k8s` | the cluster view docks beside the chat ([guide](k8s-pane.md)) |
| `/devops-assistant:status` | contexts, tiers, lock state, Argo CD, top warnings |
| "why is payments/api crashing?" or `/devops-assistant:rca payments` | read-only RCA with ranked hypotheses and a fix as a PR |
| `/devops-assistant:infra-security aws` | security overview of the logged-in AWS account ([analysis](analysis.md)) |
| `/devops-assistant:k8s-costs` | cost per namespace for the current context |
| `/devops-assistant:infra-design "shop API on AWS eu-central-1, 99.9%"` | a design folder with diagrams, WAF review and validated IaC ([design](design.md)) |
| `/devops-assistant:deploy "raise api memory limit to 512Mi in prod"` | branch → edit → validate → diff → PR ([GitOps](gitops.md)) |

## Upgrading
Plugin updates arrive through the marketplace (`/plugin marketplace update subzone`). Each version downloads or builds its own `k8sh`; your `~/.k8sh` (tiers, grants, audit log, RCA history, incidents) carries over.

**From `k8s-handler`** (renamed in 0.5.0): auto-update can't follow a rename, so reinstall once:
```
/plugin uninstall k8s-handler@subzone
/plugin marketplace update subzone
/plugin install devops-assistant@subzone
/devops-assistant:setup
```
Run setup again so the deny-list and status line use the new tool names.

## Optional: k8sh on your PATH
For `k8sh unlock` in your own terminal:
```bash
go install github.com/subzone/devops-assistant/cmd/k8sh@latest
```
or download `k8sh-<os>-<arch>` from [Releases](https://github.com/subzone/devops-assistant/releases), check it against `SHA256SUMS`, and put it on your `PATH` as `k8sh`.

## Troubleshooting
- **"k8sh binary not installed, failing closed"**: no binary yet. Run `/devops-assistant:setup`, or `"<plugin dir>/bin/k8sh-launch" version` in a terminal to see why the download or build failed.
- **MCP server failed to connect**: same cause, or a plugin installed under an old name (`k8s-handler`). Reinstall as above and restart.
- **The pane opens above the prompt instead of on the right**: the dock needs Claude Code's fullscreen layout and a wide terminal.
- **A guard denial**: it's final for that approach. Read the reason; changes go through Git, destructive actions through a grant you issue.
