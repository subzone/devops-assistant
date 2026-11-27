package kube

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
)

// SecurityCheck is one posture rule and the workloads (or bindings,
// namespaces) that break it.
type SecurityCheck struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Severity string   `json:"severity"` // high | medium | low
	Count    int      `json:"count"`
	Objects  []string `json:"objects"` // up to 25, "namespace/kind/name"
	Advice   string   `json:"advice"`
}

type SecurityReport struct {
	Context   string          `json:"context"`
	Namespace string          `json:"namespace,omitempty"`
	Summary   map[string]int  `json:"summary"` // checks failing, by severity
	Checks    []SecurityCheck `json:"checks"`
	Skipped   []string        `json:"skipped,omitempty"`
	Note      string          `json:"note"`
}

var systemNamespaces = map[string]bool{"kube-system": true, "kube-public": true, "kube-node-lease": true}

var dangerousCaps = map[string]bool{"ALL": true, "SYS_ADMIN": true, "NET_ADMIN": true, "SYS_PTRACE": true, "SYS_MODULE": true, "DAC_READ_SEARCH": true, "BPF": true}

var rules = []SecurityCheck{
	{ID: "privileged", Title: "privileged containers", Severity: "high", Advice: "Drop privileged: true; grant only the capabilities needed."},
	{ID: "host-namespaces", Title: "host network, PID or IPC", Severity: "high", Advice: "Remove hostNetwork/hostPID/hostIPC unless it is a node agent that needs it."},
	{ID: "host-path", Title: "hostPath volumes", Severity: "high", Advice: "Use PVCs, ConfigMaps or projected volumes instead of mounting the node's filesystem."},
	{ID: "dangerous-capabilities", Title: "dangerous capabilities added", Severity: "high", Advice: "Remove ALL/SYS_ADMIN/NET_ADMIN/SYS_PTRACE…; drop: [ALL] and add back only what is needed."},
	{ID: "cluster-admin", Title: "cluster-admin bound to users, groups or app service accounts", Severity: "high", Advice: "Bind narrow Roles per namespace; keep cluster-admin for break-glass only."},
	{ID: "run-as-root", Title: "may run as root", Severity: "medium", Advice: "Set runAsNonRoot: true and a non-zero runAsUser."},
	{ID: "privilege-escalation", Title: "privilege escalation allowed", Severity: "medium", Advice: "Set allowPrivilegeEscalation: false."},
	{ID: "no-network-policy", Title: "namespaces without a NetworkPolicy", Severity: "medium", Advice: "Add a default-deny NetworkPolicy and allow only the traffic each app needs."},
	{ID: "latest-tag", Title: "images without a pinned tag (:latest or none)", Severity: "low", Advice: "Pin a version tag or, better, a digest."},
	{ID: "no-memory-limit", Title: "containers without a memory limit", Severity: "low", Advice: "Set resources.limits.memory (and requests) so one pod can't starve a node."},
	{ID: "writable-root-fs", Title: "writable root filesystem", Severity: "low", Advice: "Set readOnlyRootFilesystem: true and mount writable emptyDirs where needed."},
}

var sevRank = map[string]int{"high": 3, "medium": 2, "low": 1}

// Security runs read-only posture checks over pods (by owning workload),
// ClusterRoleBindings and NetworkPolicies. System namespaces are left out
// unless includeSystem. Nothing is changed and no Secret is read.
func (c *Client) Security(ctx context.Context, s Scope, includeSystem bool) (*SecurityReport, error) {
	all := s.Namespace == ""
	pb, err := c.GetJSON(ctx, s, "pods", "", "", all)
	if err != nil {
		return nil, err
	}
	var pl podList2
	if err := json.Unmarshal(pb, &pl); err != nil {
		return nil, err
	}
	hits := map[string]map[string]bool{}
	hit := func(id, obj string) {
		if hits[id] == nil {
			hits[id] = map[string]bool{}
		}
		hits[id][obj] = true
	}
	podNamespaces := map[string]bool{}
	for _, p := range pl.Items {
		ns := p.Metadata.Namespace
		if ns == "" {
			ns = s.Namespace
		}
		if !includeSystem && systemNamespaces[ns] {
			continue
		}
		if p.Status.Phase == "Succeeded" || p.Status.Phase == "Failed" {
			continue
		}
		podNamespaces[ns] = true
		obj := ns + "/" + p.owner()
		sp := p.Spec
		if sp.HostNetwork || sp.HostPID || sp.HostIPC {
			hit("host-namespaces", obj)
		}
		for _, v := range sp.Volumes {
			if v.HostPath != nil {
				hit("host-path", obj)
			}
		}
		podNonRoot := sp.SecurityContext != nil && sp.SecurityContext.RunAsNonRoot != nil && *sp.SecurityContext.RunAsNonRoot
		podUser := sp.SecurityContext != nil && sp.SecurityContext.RunAsUser != nil && *sp.SecurityContext.RunAsUser > 0
		for _, ct := range append(append([]container{}, sp.InitContainers...), sp.Containers...) {
			sc := ct.SecurityContext
			if sc != nil && sc.Privileged != nil && *sc.Privileged {
				hit("privileged", obj)
			}
			if sc == nil || sc.AllowPrivilegeEscalation == nil || *sc.AllowPrivilegeEscalation {
				hit("privilege-escalation", obj)
			}
			nonRoot := podNonRoot || (sc != nil && sc.RunAsNonRoot != nil && *sc.RunAsNonRoot)
			user := podUser || (sc != nil && sc.RunAsUser != nil && *sc.RunAsUser > 0)
			if sc != nil && sc.RunAsUser != nil && *sc.RunAsUser == 0 {
				user, nonRoot = false, false
			}
			if !nonRoot && !user {
				hit("run-as-root", obj)
			}
			if sc != nil && sc.Capabilities != nil {
				for _, cap := range sc.Capabilities.Add {
					if dangerousCaps[strings.ToUpper(strings.TrimPrefix(cap, "CAP_"))] {
						hit("dangerous-capabilities", obj)
					}
				}
			}
			if sc == nil || sc.ReadOnlyRootFilesystem == nil || !*sc.ReadOnlyRootFilesystem {
				hit("writable-root-fs", obj)
			}
			if ct.Resources.Limits["memory"] == "" {
				hit("no-memory-limit", obj)
			}
			if !pinned(ct.Image) {
				hit("latest-tag", obj)
			}
		}
	}

	rep := &SecurityReport{Context: s.Context, Namespace: s.Namespace, Summary: map[string]int{"high": 0, "medium": 0, "low": 0}}

	// NetworkPolicy coverage: namespaces with pods and no policy
	if nb, err := c.GetJSON(ctx, s, "networkpolicies", "", "", all); err == nil {
		var np struct {
			Items []struct {
				Metadata struct{ Namespace string } `json:"metadata"`
			}
		}
		covered := map[string]bool{}
		if json.Unmarshal(nb, &np) == nil {
			for _, it := range np.Items {
				covered[it.Metadata.Namespace] = true
			}
			if s.Namespace != "" && len(np.Items) > 0 {
				covered[s.Namespace] = true
			}
		}
		for ns := range podNamespaces {
			if !covered[ns] {
				hit("no-network-policy", ns+"/namespace/"+ns)
			}
		}
	} else {
		rep.Skipped = append(rep.Skipped, "no-network-policy: "+err.Error())
	}

	// cluster-admin bindings, cluster-wide only
	if all {
		if bb, err := c.GetJSON(ctx, s, "clusterrolebindings", "", "", false); err == nil {
			var crb struct {
				Items []struct {
					Metadata struct{ Name string } `json:"metadata"`
					RoleRef  struct{ Name string } `json:"roleRef"`
					Subjects []struct{ Kind, Name, Namespace string }
				}
			}
			if json.Unmarshal(bb, &crb) == nil {
				for _, b := range crb.Items {
					if b.RoleRef.Name != "cluster-admin" {
						continue
					}
					for _, sub := range b.Subjects {
						if strings.HasPrefix(sub.Name, "system:") || (sub.Kind == "ServiceAccount" && systemNamespaces[sub.Namespace]) {
							continue
						}
						hit("cluster-admin", "clusterrolebinding/"+b.Metadata.Name+" → "+strings.ToLower(sub.Kind)+"/"+sub.Name)
					}
				}
			}
		} else {
			rep.Skipped = append(rep.Skipped, "cluster-admin: "+err.Error())
		}
	}

	for _, r := range rules {
		objs := hits[r.ID]
		if len(objs) == 0 {
			continue
		}
		r.Count = len(objs)
		for o := range objs {
			r.Objects = append(r.Objects, o)
		}
		sort.Strings(r.Objects)
		if len(r.Objects) > 25 {
			r.Objects = r.Objects[:25]
		}
		rep.Checks = append(rep.Checks, r)
		rep.Summary[r.Severity]++
	}
	sort.SliceStable(rep.Checks, func(i, j int) bool {
		a, b := rep.Checks[i], rep.Checks[j]
		if sevRank[a.Severity] != sevRank[b.Severity] {
			return sevRank[a.Severity] > sevRank[b.Severity]
		}
		return a.Count > b.Count
	})
	if rep.Checks == nil {
		rep.Checks = []SecurityCheck{}
	}
	rep.Note = "Read-only posture checks over running workloads, ClusterRoleBindings and NetworkPolicies; not a vulnerability scan. Fix through Git: change the manifests and open a PR."
	return rep, nil
}

// pinned: a digest, or a tag other than latest.
func pinned(image string) bool {
	if strings.Contains(image, "@sha256:") {
		return true
	}
	last := image[strings.LastIndex(image, "/")+1:]
	i := strings.LastIndex(last, ":")
	return i >= 0 && last[i+1:] != "" && last[i+1:] != "latest"
}
