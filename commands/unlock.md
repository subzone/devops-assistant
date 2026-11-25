---
description: Show how to unlock ONE destructive action (you run it yourself)
argument-hint: "<context> <action> <kind/name> [namespace]"
disable-model-invocation: true
---

The user wants to unlock a destructive action: $ARGUMENTS

You cannot unlock anything. Grants are issued only by the user, in their own terminal, by typing the context name.

1. Map the arguments to: context, action (one of: delete, scale-zero, drain, cordon, sync-prune, app-delete, helm-uninstall, rollback, chaos-run, dr-restore, upgrade, ansible-destructive, force-push, secret-rotate), target (exact kind/name, no wildcards), namespace.
2. Use `k8s_contexts` to show the context's tier. If it is `prod`, say so prominently.
3. Print exactly this for the user to copy into a **separate terminal** (not this chat, not `!` mode):

```
k8sh unlock --context <context> --namespace <namespace or -> --action <action> --target <kind/name> --ttl 10m
```

4. Explain in one line: single use, at most 15 minutes, exact scope only.

Do not run the command. Do not call any destructive tool until the user says the grant is issued.
