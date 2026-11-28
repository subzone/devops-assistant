---
description: On-prem review — vSphere, Proxmox, KVM or bare metal — inventory, capacity, health, patch level and end-of-life (read-only)
argument-hint: "<vsphere|proxmox <host>|kvm <host>|ansible <inventory> [pattern]>"
---

Delegate to the `inventory-analyst` agent, following the `onprem-ops` skill: $ARGUMENTS. Use the access the user already has (govc env, SSH keys, Ansible inventory); never ask for passwords.

Return:
- the inventory table (site/cluster, host, VMs or role, CPU/memory, OS/version, EOL date)
- capacity: utilisation, overcommit, N+1 headroom, storage
- risks worst first (EOL, no N+1, full storage, old snapshots, failed backups, exposed management, missing firewall), each with a fix as code or a ticket
- which Kubernetes clusters each finding affects
