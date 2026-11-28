# The k8s pane

Type `/k8s` and the cluster view opens on the right side of the chat, inside the same Claude Code session: no tmux, no second window, no separate process. It works in any terminal, Apple Terminal included, and in the Code tab of the Claude desktop app. `/k8s` again (or Esc while the pane has focus) closes it; `/devops-assistant:ui` opens the same pane.

```
 1 Cluster 2 Argo CD 3 RCA 4 Lock 5 Fleet 6 Security 7 Incidents │ ...chat...
 context k3d-mycluster [dev] ▾   LOCKED                           │
 ⌂ Cluster › payments › deploy/api › pod/api-2                    │
 [ Logs ] [ Prev logs ] [ Events ] [ Describe ] [ Ask Claude ]    │
 ▾ ✖ payments  ✖1 ⚠1                                              │
   ▾ ⚠ deploy/api  1/2                                            │
     ▸ ✔ pod/api-1  Running  age 3d                               │
     ▸ ✖ pod/api-2  OOMKilled  r:7 (last 30s ago)                 │
 ──────────────────────────────────────                           │
 Pod payments/api-2  phase: Running  restarts: 7                  │
```

The right-side dock needs Claude Code's fullscreen layout and a wide enough terminal; otherwise the pane opens above the prompt, which is normal Claude Code behaviour.

## Tabs (hotkeys 1-7)
- **Cluster:** namespaces → workloads → pods → containers. Namespaces show their pods' health (`payments  ✖2 ⚠1`) and broken ones sort first. Pods sit under their workload by owner (pod → ReplicaSet → Deployment, StatefulSet, DaemonSet; Job pods under their Job; labels as fallback). Init containers count: a pod stuck in `Init:CrashLoopBackOff` says so.
- **Argo CD:** apps → resources, problems first.
- **RCA:** ranked findings, recent warnings and 7 days of history.
- **Lock:** lock state, active grants with expiry, contexts and tiers.
- **Fleet:** every context at a glance, troubled ones first: reachable, nodes ready, failing and not-ready pods, warnings of the last 15 minutes, degraded or out-of-sync Argo CD apps, top problems. **Switch to** opens a context in the other tabs.
- **Security:** read-only posture checks, worst first: privileged containers, host network/PID/IPC and hostPath, dangerous capabilities, root, privilege escalation, unpinned images, missing memory limits, writable root filesystems, cluster-admin bound to people or app service accounts, namespaces without a NetworkPolicy. Each check lists the workloads that break it (Events, Describe and Ask Claude work on them) and the fix through Git. Not a vulnerability scan; for clouds use `/devops-assistant:infra-security`.
- **Incidents:** alerts, active and resolved incidents with their timelines.

## Navigating
- Click a row to select it; click again to expand or collapse. The breadcrumb jumps back to any level; `⌂` collapses everything. Long lists show 30 rows with `more…`.
- The action buttons sit right under the breadcrumb. While logs or describe output is open, the tree shows only the rows around your selection.
- The **filter** field narrows the top level as you type; **⚠ problems only** hides healthy rows.
- Logs, previous logs, events and describe open in the detail area (`✕ close` returns). **Ask Claude** sends a short, redacted description of the selection and the last output to the chat; Claude diagnoses it with the `rca-runbook` skill.
- Health ages out what is over: an OOM kill on a container that has been ready for more than an hour, a Job run that failed hours ago and an evicted leftover count as history (shown in details), not as failing pods — the same in the pane, the fleet view, RCA and monitoring.

## RCA history, monitoring and incidents
- **RCA history:** every RCA collection is recorded on this machine: when each problem was first and last seen, how often it came back, when it resolved. Claude reads it with `rca_history` ("since when?", "has this happened before?").
- **Monitoring** is off until you switch it on in the Incidents tab. Then every 60 s (setting **Monitoring: every N seconds**) it collects RCA on the watched contexts (**Monitoring: contexts**: current, all, or a list) and turns what opened or resolved into alerts: a toast, Steve, the Incidents tab, and a note on every active incident that names the object. The first run is a baseline: one line about what is broken already. The status line shows `◉ monitoring` while it runs.
- **Incidents:** **Open incident…** on any ✖/⚠ row (a pod, an alert, a security check, a context) records an incident with a severity (sev1–sev4), the objects and the row's details. Then **Note…**, **Mitigated**, **Resolve**, **Reopen** and **Draft postmortem**, which asks Claude for a blameless postmortem in `docs/incidents/<id>.md` from the timeline, the RCA history and what changed. Claude manages incidents too (`incident_*` tools). They live in `~/.k8sh/incidents.json`, redacted, and never touch a cluster.

## Unlock
**Unlock…** on a pod or workload asks you to type the context name, then issues one grant: delete for pods and daemonsets, delete or scale to 0 for deployments and statefulsets. It is single use, for that exact target, expires within 15 minutes and is audited. Only you can press it: Claude has no tool, command or prompt that reaches it. See [SECURITY.md](../SECURITY.md).

## Status and refresh
The status line shows `k8s <context> [<tier>] LOCKED` (or `UNLOCKED xN`). The pane refreshes on open, on ⟳, on tab or context change, every 15 s while open (Fleet and Security every 2 minutes), and after Claude uses a k8sh tool. Everything shown comes from the k8sh MCP tools, so it is redacted; the pane never reads kubeconfig, and switching its context doesn't change kubectl's current context.

## Steve
In the docked pane, Steve sits in the background, bottom right, in shades of one blue, with the plugin's version under him. He listens while you type or dictate, thinks while Claude works (his bubble names the tool, never its arguments), grumbles a line when an answer is done, facepalms when a new problem shows up, and grins at a grant. He's a grumpy DevOps engineer: blunt, dry, no pleasantries; with **Steve swears** on (the default), mild bad words about the code and the situation ("who the hell deployed this crap?"), never slurs, never at anyone's identity. He shows only in empty cells, so he never covers text. The look button cycles Steve → ∞ (a swaying 3D DevOps loop) → off.

His lines are canned and no answer goes anywhere, unless you turn on **Steve reads Claude's answers** in `/config`: then each finished answer, redacted, goes to one small `haiku` call so he can react in his own words (counted in `/cost`), and the pane shows **👁 reads answers (haiku)**.

### Voice and ears (optional, all local)
- **♪ voice** makes him say his lines aloud (off by default). **Steve's speech engine** `auto` uses [Piper](https://github.com/OHF-Voice/piper1-gpl) when it and the voice in **Steve's Piper voice** (default `en_US-ryan-medium`) are installed, else the macOS voices (**Steve's voice**: auto picks a Premium, then Enhanced English voice, else Rocko).
  ```bash
  pipx install piper-tts
  "$(pipx environment --value PIPX_LOCAL_VENVS)/piper-tts/bin/python" -m piper.download_voices --download-dir ~/.local/share/piper-voices en_US-ryan-medium
  ```
- **🎤 talk:** ffmpeg records until you pause (or press again, or 30 s), whisper.cpp transcribes on your machine, and the text lands in the prompt box for you to check and send (**Send what Steve hears** sends it at once). macOS asks once to let your terminal use the microphone. Nothing records unless you press the button, and no audio leaves your machine.
  ```bash
  brew install whisper-cpp ffmpeg
  mkdir -p ~/.local/share/whisper-models && curl -fL -o ~/.local/share/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
  ```
  `/devops-assistant:setup` (group **pane**) does both for you.

Steve's frames are built from the Steve Trash export by `node scripts/steve-frames.mjs <export dir>`.

## The standalone TUI
`k8sh tui` (and `k8sh workspace`, a tmux layout with Claude on the left) is still there as a fallback for a Claude Code that doesn't load mods. Press `f` on a row there and run `/devops-assistant:explain` to send it to Claude.
