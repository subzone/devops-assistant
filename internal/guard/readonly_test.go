package guard

import "testing"

func TestAnalysisToolsDenied(t *testing.T) {
	denied := []string{
		// ansible: only fact modules ad hoc
		"ansible all -m shell -a 'rm -rf /tmp/x'",
		"ansible web -i inv.ini -a 'reboot'",
		"ansible all -m ansible.builtin.copy -a 'src=a dest=/b'",
		"ansible all --module-name=service -a 'name=nginx state=stopped'",
		"ansible-inventory -i inv.ini --list",
		"ansible-inventory -i inv.ini --host web1",
		"ansible-vault view secrets.yml",
		// vSphere
		"govc vm.power -off web-1",
		"govc vm.destroy web-1",
		"govc snapshot.remove -vm web-1 '*'",
		"govc host.maintenance.enter esx1",
		"govc host.esxcli system shutdown",
		"govc env",
		"govc vm.info -e web-1",
		"govc datastore.download x.vmdk .",
		// Proxmox / KVM
		"pvesh set /nodes/pve1/qemu/100/config --memory 8192",
		"pvesh create /nodes/pve1/qemu/100/status/stop",
		"ssh root@pve1 'pvesh delete /nodes/pve1/qemu/100'",
		"qm stop 100",
		"qm destroy 100",
		"qm guest exec 100 -- id",
		"pct set 200 --memory 512",
		"virsh destroy web",
		"virsh -c qemu:///system undefine web",
		"virsh dumpxml web --security-info",
		// scanners and storage writes
		"prowler aws --fixer",
		"prowler aws --fix",
		"trivy k8s --report summary",
		"gcloud storage rm gs://b/x",
		"gsutil -m rm -r gs://b",
		"aliyun oss rm oss://b/x",
		"az storage blob upload -c c -f f -n n",
	}
	for _, c := range denied {
		if d := Bash(c); d.Allow {
			t.Errorf("expected deny: %q", c)
		}
	}
}

func TestAnalysisToolsAllowed(t *testing.T) {
	allowed := []string{
		"ansible all -i inv.ini -m setup --tree /tmp/facts",
		"ansible all -m ansible.builtin.package_facts",
		"ansible web -m ping",
		"ansible --version",
		"ansible-inventory -i inv.ini --graph",
		"govc about",
		"govc ls -l '/*/host/*'",
		"govc find / -type m",
		"govc vm.info -json web-1",
		"govc host.info -json",
		"govc datastore.info -json",
		"govc metric.sample -n 12 esx1 cpu.usage.average",
		"govc snapshot.tree -vm web-1",
		"govc events -n 100",
		"pvesh get /cluster/resources --output-format json",
		"ssh root@pve1 pvesh get /nodes",
		"qm list",
		"qm config 100",
		"pct list",
		"virsh list --all",
		"virsh -c qemu:///system dominfo web",
		"prowler aws --output-formats json-ocsf --output-directory /tmp/p --severity critical high",
		"prowler azure --az-cli-auth",
		"trivy k8s --disable-node-collector --report summary",
		"trivy config ./infra",
		"aws securityhub get-findings --max-items 200",
		"aws resource-explorer-2 search --query-string '*'",
		"aws ec2 describe-security-groups --filters Name=ip-permission.cidr,Values=0.0.0.0/0",
		"az security assessment list",
		"az graph query -q 'Resources | project name, type'",
		"gcloud scc findings list organizations/1 --filter='state=\"ACTIVE\"'",
		"gcloud asset search-all-resources --scope=projects/p",
		"gcloud projects get-iam-policy p --format=json",
		"gcloud storage buckets list --format=json",
		"hcloud firewall list -o json",
		"doctl compute firewall list -o json",
		"aliyun ecs DescribeSecurityGroups --RegionId eu-central-1",
		"kubectl get --raw '/api/v1/namespaces/opencost/services/opencost:9003/proxy/allocation/compute?window=7d'",
		"kubectl top pods -A --containers",
	}
	for _, c := range allowed {
		if d := Bash(c); !d.Allow {
			t.Errorf("expected allow: %q (%s)", c, d.Reason)
		}
	}
}
