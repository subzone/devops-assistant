---
name: onprem-ops
description: Read-only analysis of on-prem and private-cloud environments — VMware vSphere (govc), Proxmox VE (pvesh, qm, pct), KVM/libvirt (virsh) and bare metal (Ansible facts) — inventory, capacity, health, patch level and end-of-life, and basic security posture, matched with the Kubernetes clusters running there. Use when the user asks about on-prem, datacenter, vSphere, Proxmox, bare-metal servers, capacity, or old OS/firmware.
---

# On-prem analysis (read-only)

Use the user's existing access (govc env vars, SSH keys, Ansible inventory); never ask for or print passwords. Best identity: vSphere **Read-only** role, Proxmox **PVEAuditor**, an Ansible user without sudo for facts that don't need it. The guard allows only the read commands below; anything else is a change and goes through Git (Ansible playbooks in check mode via k8sh, or Terraform/Packer), with a user grant if destructive.

## 1. Collect
| Platform | Inventory | Capacity / health |
|---|---|---|
| vSphere | `govc about`, `govc ls -l /*/host/*`, `govc find / -type m` (VMs), `govc vm.info -json <vm>` (never `-e`: extraConfig can hold guestinfo secrets), `govc host.info -json`, `govc datastore.info -json` | `govc metric.sample -n 12 <host> cpu.usage.average mem.usage.average`, `govc events -n 100`, `govc tasks`, snapshots `govc snapshot.tree -vm <vm>` (old snapshots fill datastores) |
| Proxmox VE (on the host, or `ssh <host> …`) | `pvesh get /cluster/resources --output-format json`, `pvesh get /nodes --output-format json`, `qm list`, `pct list`, `qm config <id>`, `pct config <id>` | `pvesh get /nodes/<n>/status`, `pvesh get /cluster/ha/status/current`, `pvesh get /nodes/<n>/storage --output-format json`, `pvesh get /cluster/backup`, pending updates `pvesh get /nodes/<n>/apt/update` |
| KVM / libvirt | `virsh list --all`, `virsh dominfo <d>`, `virsh domblklist <d>`, `virsh pool-list --all`, `virsh net-list --all` | `virsh nodeinfo`, `virsh domstats`, `virsh nodememstats` |
| Bare metal / any Linux | `ansible <pattern> -i <inventory> -m setup --tree "$OUT/facts"` (also `-m package_facts`, `-m service_facts`); only fact-gathering modules are allowed ad hoc | from facts: `ansible_processor_vcpus`, `ansible_memtotal_mb`, `ansible_mounts` (free space), `ansible_uptime_seconds` |

Keep raw output in a temp directory outside the repo (`mktemp -d`): it holds hostnames and IPs. Use `ansible-inventory --graph` to see hosts; not `--list`/`--host`, which print variables.

## 2. Analyse
- **Capacity**: per cluster/host: vCPU and memory allocated vs physical (overcommit ratio), datastore/storage free %, and headroom for one host failing (N+1). Flag storage > 80% used and hosts that can't absorb a peer's VMs.
- **Health**: hosts in maintenance or disconnected, HA/quorum state, recent error events, failed backups, VMs with snapshots older than 7 days, powered-off VMs older than 30 days (candidates to retire).
- **Patch level and end-of-life**: OS from facts (`ansible_distribution`, `_version`, `ansible_kernel`), ESXi/Proxmox versions, BIOS (`ansible_bios_version`, `ansible_bios_date`). Check support dates at `https://endoflife.date/api/<product>.json` (e.g. `ubuntu`, `rhel`, `debian`, `esxi`, `proxmox-ve`, `kubernetes`): send only the product name, never hostnames. Pending updates count per host.
- **Security quick checks** (from facts and configs, no changes): SSH root login and password auth (needs a read on the host: ask first, then `ssh <host> sudo sshd -T` and look at `permitrootlogin`, `passwordauthentication`), firewall service state from `service_facts` (ufw, firewalld, nftables), time sync (chrony/ntp), hosts past EOL, management interfaces (vCenter, Proxmox :8006, iDRAC/iLO) reachable from user networks. For the Kubernetes clusters on top, use k8sh `security_overview`.
- **Kubernetes on top**: match nodes (`k8s_get` nodes: `providerID` like `k3s://`, `vsphere://<uuid>`, or hostnames) to VMs/hosts, so capacity and EOL findings name the clusters they affect.

## 3. Report
- Inventory table (site/cluster, host, VMs or role, CPU/memory, OS/version, EOL date, owner if known).
- Capacity: utilisation, overcommit, N+1 headroom, storage forecast if events/metrics give a trend.
- Risks worst first: EOL/unsupported, no N+1, full storage, old snapshots, failed backups, exposed management, missing firewall.
- Each fix is a change in code: an Ansible role/playbook (run in check mode first, through k8sh), Terraform for vSphere/Proxmox, or a ticket for hardware/firmware. Nothing is changed from here.
