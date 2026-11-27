package kube

import (
	"strings"
	"time"
)

// pod is the part of a Pod that the fleet summary and the security checks
// read: health (init containers included), owner, and security settings.
type pod struct {
	Metadata struct {
		Name            string
		Namespace       string
		Labels          map[string]string
		OwnerReferences []struct {
			Kind, Name string
			Controller bool
		}
	} `json:"metadata"`
	Spec struct {
		HostNetwork, HostPID, HostIPC bool
		ServiceAccountName            string
		SecurityContext               *podSecurity
		Volumes                       []struct {
			Name     string
			HostPath *struct{ Path string }
		}
		InitContainers []container
		Containers     []container
	} `json:"spec"`
	Status struct {
		Phase                 string
		Reason                string
		InitContainerStatuses []containerStatus
		ContainerStatuses     []containerStatus
	} `json:"status"`
}

type podSecurity struct {
	RunAsNonRoot *bool
	RunAsUser    *int64
}

type container struct {
	Name            string
	Image           string
	SecurityContext *struct {
		Privileged               *bool
		AllowPrivilegeEscalation *bool
		RunAsNonRoot             *bool
		RunAsUser                *int64
		ReadOnlyRootFilesystem   *bool
		Capabilities             *struct{ Add []string }
	}
	Resources struct {
		Limits map[string]string
	}
}

type containerStatus struct {
	Name         string
	Ready        bool
	RestartCount int
	State        struct {
		Waiting    *struct{ Reason string }
		Terminated *struct {
			Reason     string
			ExitCode   int
			FinishedAt string
		}
		Running *struct{}
	}
	LastState struct {
		Terminated *struct {
			Reason     string
			FinishedAt string
		}
	}
}

// Recent: within this, a past OOM kill or a failed Job run is a problem
// now; older, it is history (shown, not counted).
const Recent = time.Hour

// age of an RFC 3339 time; ok false when absent or unreadable.
func age(ts string, now time.Time) (time.Duration, bool) {
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return 0, false
	}
	return now.Sub(t), true
}

// finished: when the pod's containers last finished (for failed pods).
func (p pod) finished(now time.Time) (time.Duration, bool) {
	best, ok := time.Duration(1<<62), false
	for _, cs := range append(append([]containerStatus{}, p.Status.InitContainerStatuses...), p.Status.ContainerStatuses...) {
		if t := cs.State.Terminated; t != nil {
			if a, k := age(t.FinishedAt, now); k && a < best {
				best, ok = a, true
			}
		}
	}
	return best, ok
}

func (p pod) ownedBy(kind string) bool {
	for _, r := range p.Metadata.OwnerReferences {
		if r.Kind == kind {
			return true
		}
	}
	return false
}

type podList2 struct{ Items []pod }

// starting: waiting reasons that mean on the way up, not broken.
var starting = map[string]bool{"ContainerCreating": true, "PodInitializing": true}

// health is "err" (failing now), "warn" (not ready, or a recent past
// problem), "ok", or "done" (Succeeded, or a Job run that failed a while
// ago), with the reason to show; init containers count. Past problems age
// out: an OOM kill or a failed Job run older than Recent is history.
func (p pod) health(now time.Time) (string, string) {
	phase := p.Status.Phase
	switch phase {
	case "Succeeded":
		return "done", ""
	case "Unknown":
		return "err", phase
	case "Failed":
		if p.Status.Reason == "Evicted" {
			return "warn", "Evicted"
		}
		if p.ownedBy("Job") {
			if a, ok := p.finished(now); ok && a > Recent {
				return "done", "Failed (job run)"
			}
		}
		return "err", "Failed"
	}
	st, reason := "ok", ""
	worse := func(s, r string) {
		if s == "err" && st != "err" {
			st, reason = s, r
		} else if s == "warn" && st == "ok" {
			st, reason = s, r
		}
	}
	for _, cs := range p.Status.InitContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			if starting[w.Reason] {
				worse("warn", "Init:"+w.Reason)
			} else {
				worse("err", "Init:"+w.Reason)
			}
		} else if t := cs.State.Terminated; t != nil && t.ExitCode != 0 && t.Reason != "Completed" {
			worse("err", "Init:"+t.Reason)
		}
	}
	for _, cs := range p.Status.ContainerStatuses {
		if w := cs.State.Waiting; w != nil && w.Reason != "" {
			if starting[w.Reason] {
				worse("warn", w.Reason)
			} else {
				worse("err", w.Reason)
			}
		}
		if t := cs.LastState.Terminated; t != nil && t.Reason == "OOMKilled" {
			a, known := age(t.FinishedAt, now)
			switch {
			case !cs.Ready || !known || a <= Recent:
				worse("err", "OOMKilled")
			case a <= 24*time.Hour:
				worse("warn", "OOMKilled earlier")
			}
		}
		if !cs.Ready && phase == "Running" && cs.State.Waiting == nil {
			worse("warn", "NotReady")
		}
	}
	if phase == "Pending" {
		worse("warn", "Pending")
	}
	return st, reason
}

// owner names the workload a pod belongs to, as kind/name ("deployment/api"
// for a ReplicaSet named api-<pod-template-hash>), or pod/<name>.
func (p pod) owner() string {
	for _, r := range p.Metadata.OwnerReferences {
		if !r.Controller && len(p.Metadata.OwnerReferences) > 1 {
			continue
		}
		if r.Kind == "ReplicaSet" {
			if h := p.Metadata.Labels["pod-template-hash"]; h != "" && strings.HasSuffix(r.Name, "-"+h) {
				return "deployment/" + strings.TrimSuffix(r.Name, "-"+h)
			}
		}
		return strings.ToLower(r.Kind) + "/" + r.Name
	}
	return "pod/" + p.Metadata.Name
}
