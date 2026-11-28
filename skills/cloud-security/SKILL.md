---
name: cloud-security
description: Read-only security posture review of live cloud accounts on AWS, Azure, GCP, Hetzner, DigitalOcean and Alibaba — public storage, open firewalls, admin identities, old keys, encryption, audit logging, managed-Kubernetes exposure, plus the cloud's own security score. Use when the user asks for a security overview, audit, posture, CIS/compliance check or "what is exposed" in a cloud account.
---

# Cloud security overview (read-only)

Look, never fix. Every finding becomes a Terraform/Crossplane change in a PR (`iac-terraform`, `iac-crossplane`), never a CLI change. Use the user's existing CLI login; never ask for keys. Best identity for this: AWS `SecurityAudit` + `ViewOnlyAccess`, Azure `Reader` + `Security Reader`, GCP `roles/viewer` + `roles/iam.securityReviewer` + `roles/securitycenter.findingsViewer` (`docs/rbac/cloud-readonly.md`).

## 1. Scope
Confirm who and where first: `aws sts get-caller-identity`, `az account show`, `gcloud config list`, `hcloud context active`, `doctl account get`, `aliyun configure list`. Ask which accounts/subscriptions/projects and regions only if more than one is reachable. Keep raw output in a temp directory outside the repo (`mktemp -d`); it holds account IDs and IPs.

## 2. Scanner first, when there is one
- **Prowler** (AWS, Azure, GCP, Kubernetes; read-only): `prowler aws --output-formats json-ocsf --output-directory "$OUT"`, `prowler azure --az-cli-auth …`, `prowler gcp --project-id P …`, `prowler kubernetes …`. Add `--severity critical high` for a fast pass, `--compliance <framework>` for CIS etc. (`prowler <provider> --list-compliance`). If a flag fails, read `prowler <provider> --help`; don't guess. **Never `--fix`/`--fixer`** (the guard blocks it).
- **The cloud's own view**, when it's on:
  - AWS Security Hub: `aws securityhub get-findings --filters '{"RecordState":[{"Value":"ACTIVE","Comparison":"EQUALS"}],"WorkflowStatus":[{"Value":"NEW","Comparison":"EQUALS"}],"SeverityLabel":[{"Value":"CRITICAL","Comparison":"EQUALS"},{"Value":"HIGH","Comparison":"EQUALS"}]}' --max-items 200`; GuardDuty `aws guardduty list-detectors` → `list-findings`; IAM Access Analyzer `aws accessanalyzer list-analyzers` → `list-findings --analyzer-arn A`.
  - Azure Defender for Cloud: `az security secure-scores list`, `az security assessment list --query "[?status.code=='Unhealthy'].{name:displayName,resource:resourceDetails.Id}"`.
  - GCP Security Command Center: `gcloud scc findings list organizations/ORG --filter='state="ACTIVE" AND (severity="CRITICAL" OR severity="HIGH")' --limit 200` (add `--location=global` if gcloud asks).
- No scanner and no native service: run the quick checks below. Say which path you took.

## 3. Quick checks
| Check | AWS | Azure | GCP |
|---|---|---|---|
| Public storage | `aws s3control get-public-access-block --account-id A`; per bucket `aws s3api get-public-access-block`, `get-bucket-policy-status --bucket B` | `az storage account list --query "[].{n:name,publicBlob:allowBlobPublicAccess,httpsOnly:enableHttpsTrafficOnly,tls:minimumTlsVersion,net:networkRuleSet.defaultAction}"` | `gcloud storage buckets list --format=json` (`public_access_prevention`, `uniform_bucket_level_access`); `gcloud storage buckets get-iam-policy gs://B` for `allUsers`/`allAuthenticatedUsers` |
| Open to the internet | `aws ec2 describe-security-groups --filters Name=ip-permission.cidr,Values=0.0.0.0/0` (and `ip-permission.ipv6-cidr,Values=::/0`) | `az network nsg list --query "[].{nsg:name,rg:resourceGroup,open:securityRules[?access=='Allow' && direction=='Inbound' && contains(['*','Internet','0.0.0.0/0'], sourceAddressPrefix)].{rule:name,port:destinationPortRange}}"` | `gcloud compute firewall-rules list --filter="direction=INGRESS AND disabled=false AND sourceRanges:0.0.0.0/0" --format=json` |
| Admin identities | `aws iam list-entities-for-policy --policy-arn arn:aws:iam::aws:policy/AdministratorAccess`; root MFA/keys: `aws iam get-account-summary` (`AccountMFAEnabled`, `AccountAccessKeysPresent`) | `az role assignment list --all --query "[?contains(['Owner','Contributor','User Access Administrator'], roleDefinitionName)].{who:principalName,type:principalType,role:roleDefinitionName,scope:scope}"` | `gcloud projects get-iam-policy P --format=json` (`roles/owner`, `roles/editor`, any `allUsers`) |
| Long-lived keys | `aws iam list-users` → `list-access-keys --user-name U` → `get-access-key-last-used --access-key-id K` (> 90 days old or unused) | `az ad app list --all --query "[].{app:displayName,id:appId,secretsExpire:passwordCredentials[].endDateTime,certsExpire:keyCredentials[].endDateTime}"` (expiry dates only) | `gcloud iam service-accounts keys list --iam-account SA --managed-by=user` |
| Encryption | `aws ec2 get-ebs-encryption-by-default`; `aws ec2 describe-volumes --filters Name=encrypted,Values=false`; RDS `StorageEncrypted` | storage `encryption`, disks `az disk list --query "[].{n:name,enc:encryption.type}"` | CMEK only if policy requires it; default is encrypted |
| Public databases | `aws rds describe-db-instances --query "DBInstances[?PubliclyAccessible].DBInstanceIdentifier"` | `az sql server list --query "[].{n:name,public:publicNetworkAccess}"` | `gcloud sql instances list --format=json` (`ipConfiguration.ipv4Enabled`, `authorizedNetworks` with `0.0.0.0/0`) |
| Audit logging | `aws cloudtrail describe-trails`, `get-trail-status --name T` (multi-region, logging on) | `az monitor diagnostic-settings subscription list` (Activity Log exported) | `gcloud logging sinks list`; Data Access logs in `get-iam-policy` `auditConfigs` |
| Managed Kubernetes | `aws eks describe-cluster --name C --query "cluster.{public:resourcesVpcConfig.endpointPublicAccess,cidrs:resourcesVpcConfig.publicAccessCidrs,logging:logging}"` | `az aks list --query "[].{n:name,private:apiServerAccessProfile.enablePrivateCluster,ranges:apiServerAccessProfile.authorizedIpRanges,localAccounts:disableLocalAccounts}"` | `gcloud container clusters list --format=json` (`privateClusterConfig`, `masterAuthorizedNetworksConfig`, `legacyAbac`, `workloadIdentityConfig`) |

| Check | Hetzner | DigitalOcean | Alibaba |
|---|---|---|---|
| Open to the internet | `hcloud firewall list -o json` (inbound rules with `0.0.0.0/0`/`::/0`, esp. 22, 3389, DB ports) | `doctl compute firewall list -o json` (`inbound_rules[].sources.addresses`) | `aliyun ecs DescribeSecurityGroups --RegionId R` → `DescribeSecurityGroupAttribute --RegionId R --SecurityGroupId SG --Direction ingress` (`SourceCidrIp 0.0.0.0/0`) |
| Servers with no firewall | `hcloud server list -o json` (`public_net.firewalls` empty while a public IP is set) | droplets not in any firewall's `droplet_ids` (`doctl compute droplet list -o json`) | instances whose only group allows all |
| Databases | self-managed: check the servers' firewalls | `doctl databases list -o json` → `doctl databases firewalls list <id>` (no trusted sources = open) | `aliyun rds DescribeDBInstances --RegionId R` → `DescribeDBInstanceIPArrayList --DBInstanceId I` (`0.0.0.0/0`) |
| Identities and keys | project API tokens are console-only: ask the user to review them | team members and tokens: console | `aliyun ram ListUsers` → `ListAccessKeys --UserName U`, `ListPoliciesForUser --UserName U` (AdministratorAccess) |
| Audit logging | none hosted: ship to Loki | none hosted | `aliyun actiontrail DescribeTrails` |

Kubernetes inside these accounts: call k8sh `security_overview` per context (and `fleet_status` for reachability). Treat a cloud finding and a cluster finding on the same workload as one item.

## 4. Report
- One table, worst first: **severity** (critical/high/medium/low), **check**, **where** (account/subscription/project, region, resource), **why it matters** (one line), **fix** (the Terraform/Crossplane resource and attribute to change).
- Then: counts per severity and cloud, what was not checked (missing permission, service off, cloud without an API) and the scanner/score used.
- Never print a secret value, key material or connection string. Key IDs: last 4 characters only. Leave account IDs and public IPs out of anything committed to a shared repo unless the user asks.
- Offer the fixes as one PR per cloud via `/devops-assistant:deploy`; nothing is changed from here.
