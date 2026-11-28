---
description: Set up devops-assistant — tools (check and install), context tiers, Claude settings (deny-list + status line), observability, RBAC
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch version), Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch doctor:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch config:*), Bash(${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch settings:*)
---

Configure devops-assistant for the user. Do the work yourself with the commands below. Ask before writing or installing, and don't hand the user snippets to paste (except `sudo` lines, below).

`K="${CLAUDE_PLUGIN_ROOT}/bin/k8sh-launch"`

1. **Binary:** run `"$K" version`. The launcher finds a release binary, builds from source when Go is installed, or downloads the release binary for this version and checks its SHA256. If it still fails, show its error and the README's install section, and stop.
2. **Tools:**
   - Run `"$K" doctor` and summarise it per group in a few lines: what each group is for, what's there, what's missing. Required tools missing (`✖`, e.g. kubectl) come first.
   - Ask in **one** multi-select question which groups to set up. Offer only groups with something missing; pre-explain the big ones (cloud CLIs and security scanners are large; the whisper model is ~150 MB). Suggest `core` when anything required is missing. Skip the step if nothing is missing.
   - Run `"$K" doctor --plan --group <picked,groups>` and show the exact commands. Ask once to run them.
   - Run them one at a time, each as its own Bash call, and report each result. Stop at the first failure and show it.
   - Commands starting with `sudo` need the user's password: ask the user to run them with `! <command>`. Never pipe a password.
   - Lines starting with `#` have no package here: show the docs link, don't improvise a `curl | sh`.
   - Run `"$K" doctor --group <picked,groups>` again and show what changed.
   - Never install anything the user didn't pick, and never uninstall or upgrade other software.
3. **Context tiers:**
   - Run `"$K" config show` and `k8s_contexts`.
   - For each context not configured yet, ask its tier in one question (dev / staging / prod). Suggest dev for local clusters (`kind-*`, `k3d-*`, `minikube`, `docker-desktop`, `rancher-desktop`) and prod for anything you're unsure about.
   - Apply each with `"$K" config set-tier <context> <tier>`.
   - Note: tiers are labels. Destructive actions stay locked on every tier.
4. **Claude settings** (deny-list + status line):
   - Run `"$K" settings apply --statusline "$K statusline" --dry-run` and show what would be added.
   - Ask once, then run it without `--dry-run`. It only adds rules, keeps a `.bak` and never replaces an existing status line. If one exists, ask before rerunning with `--force-statusline`.
   - Use the stable marketplace path for the status line (`~/.claude/plugins/marketplaces/subzone/bin/k8sh-launch statusline`), not the versioned cache path.
5. **Observability** (optional): if they want Grafana, show the `claude mcp add grafana …` command from `docs/observability.md`. The token stays in their shell or keychain, so they run that command themselves.
6. **Read-only identities:** if any context is staging or prod, recommend `docs/rbac/agent-readonly.yaml` for the identity Claude uses there. If they set up cloud or on-prem tools, point to `docs/rbac/cloud-readonly.md`. Local dev clusters can stay as they are.
7. Finish by running `/devops-assistant:status`.
