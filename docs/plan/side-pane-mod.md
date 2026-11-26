# Phase 1 — k8s side pane as a Claude Code mod

Goal: a clickable, expandable k8s view **on the right side of the Claude Code chat**, inside the same Claude session, in a plain terminal (Apple Terminal included). No tmux, no second window, no separate TUI process. The same pane should also work in the Code tab of the Claude desktop app.

Built as a Claude Code **mod** (pane render site). Docs: https://code.claude.com/docs/en/plugins/mods/interface, https://code.claude.com/docs/en/plugins/mods/api, https://code.claude.com/docs/en/plugins/mods/reference

## Where it lives
Add it to this plugin (`devops-assistant`); don't create a separate plugin:
- `hooks/hooks.json`: add `"modules": ["./k8s-pane.js"]` next to the existing PreToolUse hook (keep that hook unchanged)
- `hooks/k8s-pane.js`: the mod
- tests next to it, using the mods test framework

## Data source
Call the existing k8sh core, so redaction and the lock stay in one place:
- `$.mcp.call` on the plugin's `k8sh` MCP server tools: `k8s_contexts`, `k8s_get`, `k8s_describe`, `k8s_events`, `k8s_logs`, `argo_apps`, `argo_app_tree`, `rca_collect`, `lock_status`, `destructive_*`
- or `$.process.run([<plugin>/bin/k8sh-launch, ...])` where a CLI call is simpler
- Never read kubeconfig or secrets directly from the mod.

## Command
- `/k8s` opens the pane (`$.ui.open({ id: 'k8s', title: 'k8s', focus: true, closeOnEscape: true, columns: ~45% })`); running it again closes it.
- Register with `immediate: true` so it opens while Claude is working.
- `/devops-assistant:ui` should open the same pane (replaces the old tmux/split launcher).

## Pane layout (top to bottom)
1. **Tab row** (plain Buttons, hotkeys 1-4): `Cluster` `Argo CD` `RCA` `Lock`. The active tab is not dimmed.
2. **Context row**: a `Select` of contexts with their tier (`k3d-mycluster [dev]`; unknown = prod), and the lock state (`LOCKED` / `UNLOCKED x1`).
3. **Breadcrumb**: `⌂ Cluster › payments › deploy/api › pod/api-1`. Each segment is a Button that jumps back there; `⌂` collapses everything to the top level.
4. **Tree**: one row per visible node, each a plain Button with `▸`/`▾`, a status icon (`✔` ok, `⚠` warn, `✖` error) and a label. Pressing a row selects it; pressing the selected row expands or collapses it.
   - Cluster: namespaces → workloads (deploy/sts/ds, `ready/want`) → pods (phase, reason such as CrashLoopBackOff/OOMKilled, restarts) → containers (state, restarts, image)
   - Argo CD: apps (sync/health, problems first) → resources (sync/health). If the CRD is missing, show "Argo CD not installed in this context".
   - RCA: ranked findings from `rca_collect` + recent warnings
   - Lock: lock state, active grants with expiry, contexts and tiers
   - Long lists: show ~30 rows and add `more…` / paging Buttons
5. **Detail**: the selected node's summary, or the output of the last action (logs / events / describe), in `Code` or `Text` with wrap. A `✕ close` Button returns to the summary.
6. **Action row** (Buttons, shown for the selected node's kind):
   - Pod / Container: `Logs` `Prev logs` `Events` `Describe`
   - Workload / Namespace / App: `Events` `Describe`
   - Always: `Ask Claude` `← Back` `⌂ Top` `⟳ Refresh`
   - Pod / Workload: `Unlock…` (see below)

## Ask Claude
`Ask Claude` calls `$.prompt.submit({ text, asUser: true })` with a short, redacted description of the selection (context, tier, namespace, kind/name, status, the last detail output). Claude then diagnoses it in the chat following the `rca-runbook` skill. No copy-paste or focus file needed.

## Status line
`$.ui.status('k8s <context> [<tier>] LOCKED')`, updated on context switch and on grant changes.

## Refresh
- On open, on `⟳ Refresh`, and on tab or context change
- A light timer (`$.clock.every(15000, …)`) only while the pane is open, and only for the visible tab
- After any `mcp__plugin_devops-assistant_k8sh__*` tool call finishes (tool events), so the pane reflects what Claude just looked at

## Unlock from the pane (security-relevant)
- `Unlock…` shows an `Input`: "Type the context name to allow ONE <action> on <kind/name>". Actions: `delete` for pods; `delete` or `scale-zero` for workloads.
- On submit, issue the grant only if the typed text equals the context exactly. The rules stay the same: single use, exact scope, ≤15 min, written to the audit log.
- Only the user can press mod buttons or type into a mod Input; Claude has no way to do it. Claude must never be able to trigger this path: no tool, no command and no prompt route to it.
- Implementation: add a small `k8sh` subcommand the mod calls, e.g. `k8sh grant-from-ui --context C --namespace N --action A --target kind/name --confirm <typed>`, that only accepts calls from the mod. It must not become a way for the agent's Bash to unlock; the guard already blocks `k8sh … unlock|grant` in Bash. Document the remaining same-user limit in SECURITY.md.

## Must hold
- Pane is read-only except for Unlock; all other changes stay Git → PR/push → Argo CD
- Everything shown goes through k8sh redaction
- Works in a plain terminal; in a narrow terminal it sits above the prompt (expected Claude Code behaviour)
- The `k8s-safety` rules are unchanged

## Test before calling it done
1. `claude plugin validate`
2. The mods test framework: render each tab, press tree rows, expand and collapse, breadcrumb jump, Back/Top, Logs/Events/Describe, Ask Claude (stub `$.prompt.submit`), Unlock with wrong and right context text
3. Real run: `claude --plugin-dir .` in Apple Terminal at full width against `k3d-mycluster`, open `/k8s`, click through every tab and action, and check the pane sits on the right with the chat still usable
4. Bump the plugin version, push to `main`

## Keep / remove
Keep `k8sh tui` and `k8sh workspace` as a fallback for now. Stop recommending them; the pane is the default.
