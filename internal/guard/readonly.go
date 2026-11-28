package guard

import (
	"regexp"
	"strings"
)

// Tools whose write commands are too many to deny one by one are
// allow-listed instead: only the read subcommands below may run.
// Everything else is a change and goes through Git (Ansible in check mode
// via k8sh, Terraform/Packer), with a user grant when it is destructive.

const onpremChange = " is not a read-only command; on-prem changes go through Git (Ansible check mode via k8sh, Terraform), with a user grant if destructive"

type allowList struct {
	tool *regexp.Regexp // captures the rest of the shell segment
	sub  *regexp.Regexp // allowed subcommands
	skip map[string]bool
}

func seg(tool string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)` + b + tool + `(?:\s+([^;&|]*))?(?:$|[;&|])`)
}

var readOnlyLists = map[string]allowList{
	"govc":  {seg(`govc`), regexp.MustCompile(`^(about(\.cert)?|ls|find|tree|events|tasks|logs(\.ls)?|version|metric\.(ls|info|sample)|object\.collect|vm\.ip|session\.ls|([a-z0-9_-]+\.)+(info|ls|tree)|-h|--help|help)$`), nil},
	"pvesh": {seg(`pvesh`), regexp.MustCompile(`^(get|ls|usage|help|-h|--help)$`), nil},
	"qm":    {seg(`qm`), regexp.MustCompile(`^(list|config|status|pending|listsnapshot|help)$`), nil},
	"pct":   {seg(`pct`), regexp.MustCompile(`^(list|config|status|pending|listsnapshot|df|help)$`), nil},
	"virsh": {seg(`virsh`), regexp.MustCompile(`^(list|dominfo|domstate|domstats|domblklist|domiflist|domblkinfo|dumpxml|nodeinfo|nodememstats|nodecpustats|pool-list|pool-info|vol-list|vol-info|net-list|net-info|capabilities|version|hostname|sysinfo|uri|help)$`),
		map[string]bool{"-c": true, "--connect": true}},
}

var (
	ansibleSeg     = seg(`ansible`)
	ansibleModule  = regexp.MustCompile(`(?:^|\s)(?:-m|--module-name)(?:\s+|=)['"]?([\w.]+)`)
	ansibleArgs    = regexp.MustCompile(`(?:^|\s)(?:-a|--args)(?:\s|=)`)
	ansibleFacts   = map[string]bool{"setup": true, "gather_facts": true, "ping": true, "package_facts": true, "service_facts": true}
	trivyK8s       = seg(`trivy\s+(?:k8s|kubernetes)`)
	virshSecretOut = regexp.MustCompile(`--security-info\b`)
)

// subcommand returns the first argument that is not a flag (or a flag's value).
func subcommand(rest string, valueFlags map[string]bool) string {
	f := strings.Fields(rest)
	for i := 0; i < len(f); i++ {
		t := strings.Trim(f[i], `"'()`)
		if valueFlags[t] {
			i++
			continue
		}
		if strings.HasPrefix(t, "-") && valueFlags != nil {
			continue
		}
		return strings.ToLower(t)
	}
	return ""
}

func readOnlyTools(cmd string) Decision {
	for name, l := range readOnlyLists {
		for _, m := range l.tool.FindAllStringSubmatch(cmd, -1) {
			sub := subcommand(m[1], l.skip)
			if sub == "" {
				continue
			}
			if !l.sub.MatchString(sub) {
				return deny(name + " " + sub + onpremChange)
			}
			if name == "virsh" && virshSecretOut.MatchString(m[1]) {
				return deny("virsh --security-info prints console passwords")
			}
		}
	}
	for _, m := range ansibleSeg.FindAllStringSubmatch(cmd, -1) {
		rest := m[1]
		mod := ansibleModule.FindStringSubmatch(rest)
		if mod == nil {
			if ansibleArgs.MatchString(rest) {
				return deny("ad-hoc ansible without -m runs the command module" + onpremChange)
			}
			continue
		}
		name := strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(mod[1]), "ansible.builtin."), "ansible.legacy.")
		if !ansibleFacts[name] {
			return deny("ad-hoc ansible module " + mod[1] + onpremChange + " (only setup, gather_facts, ping, package_facts, service_facts run ad hoc)")
		}
	}
	for _, m := range trivyK8s.FindAllStringSubmatch(cmd, -1) {
		if !strings.Contains(m[1], "--disable-node-collector") {
			return deny("trivy k8s starts node-collector Jobs in the cluster; add --disable-node-collector (or run node checks as a GitOps Job)")
		}
	}
	return allow()
}
