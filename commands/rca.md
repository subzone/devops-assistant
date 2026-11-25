---
description: Root-cause analysis for a namespace or workload
argument-hint: "<namespace> [context] [workload]"
---

Run a root-cause analysis for: $ARGUMENTS

Delegate to the `rca-investigator` agent. It must stay read-only and follow the `rca-runbook` skill.

Return:
- **Symptom** (one line)
- **Most likely cause** with evidence (resource, event, log line, metric, commit)
- **Other hypotheses** ranked, each with what would confirm or rule it out
- **Fix**, as a GitOps change (file + diff) to go through `/k8s-handler:deploy`. Never as a direct kubectl mutation.
- If the fix needs a destructive action (delete pod, scale to 0, rollback), state the exact `k8sh unlock …` command for the user to run in their own terminal. Do not run it.
