package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Finding is one RCA signal, ranked by severity (higher first).
type Finding struct {
	Severity  int    `json:"severity"`
	Namespace string `json:"namespace,omitempty"`
	Object    string `json:"object"`
	Signal    string `json:"signal"`
	Detail    string `json:"detail"`
}

type RCAReport struct {
	Context   string    `json:"context"`
	Namespace string    `json:"namespace"`
	Findings  []Finding `json:"findings"`
	Warnings  []Event   `json:"recentWarnings"`
	Hint      string    `json:"hint"`
	Truncated int       `json:"truncated,omitempty"`
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name            string
			Namespace       string
			OwnerReferences []struct{ Kind, Name string }
		} `json:"metadata"`
		Spec struct {
			NodeName string
		} `json:"spec"`
		Status struct {
			Phase                 string
			Reason                string
			Conditions            []struct{ Type, Status, Reason, Message string }
			InitContainerStatuses []struct {
				Name         string
				RestartCount int
				Image        string
				State        struct {
					Waiting    *struct{ Reason, Message string }
					Terminated *struct {
						Reason   string
						ExitCode int
					}
				}
			}
			ContainerStatuses []struct {
				Name         string
				Ready        bool
				RestartCount int
				Image        string
				State        struct {
					Waiting    *struct{ Reason, Message string }
					Terminated *struct {
						Reason     string
						ExitCode   int
						FinishedAt string
					}
				}
				LastState struct {
					Terminated *struct {
						Reason     string
						ExitCode   int
						FinishedAt string
					}
				}
			}
		} `json:"status"`
	}
}

// RCA collects pod and event signals for a namespace.
func (c *Client) RCA(ctx context.Context, s Scope) (*RCAReport, error) {
	b, err := c.GetJSON(ctx, s, "pods", "", "", s.Namespace == "")
	if err != nil {
		return nil, err
	}
	var pl podList
	if err := json.Unmarshal(b, &pl); err != nil {
		return nil, err
	}
	rep := &RCAReport{Context: s.Context, Namespace: s.Namespace}
	now := c.now()
	var ns string
	add := func(sev int, obj, sig, det string) {
		rep.Findings = append(rep.Findings, Finding{Severity: sev, Namespace: ns, Object: obj, Signal: sig, Detail: det})
	}
	for _, p := range pl.Items {
		ns = p.Metadata.Namespace
		if ns == "" {
			ns = s.Namespace
		}
		obj := "pod/" + p.Metadata.Name
		if p.Status.Phase == "Pending" {
			msg := ""
			for _, c := range p.Status.Conditions {
				if c.Type == "PodScheduled" && c.Status == "False" {
					msg = c.Reason + ": " + c.Message
				}
			}
			add(8, obj, "Pending", msg)
		}
		if p.Status.Phase == "Failed" {
			// a Job run that failed a while ago, or an evicted leftover, is history
			old := false
			for _, o := range p.Metadata.OwnerReferences {
				if o.Kind == "Job" {
					for _, cs := range p.Status.ContainerStatuses {
						if t := cs.State.Terminated; t != nil {
							if a, ok := age(t.FinishedAt, now); ok && a > Recent {
								old = true
							}
						}
					}
				}
			}
			switch {
			case p.Status.Reason == "Evicted":
				add(4, obj, "Evicted", "evicted pod left behind; safe to clean up through its owner")
			case !old:
				add(7, obj, "Failed", p.Status.Reason)
			}
		}
		// a pod stuck in an init container never reaches its main containers
		for _, cs := range p.Status.InitContainerStatuses {
			cobj := obj + "/" + cs.Name
			if w := cs.State.Waiting; w != nil && w.Reason != "" && w.Reason != "PodInitializing" {
				add(9, cobj, "Init:"+w.Reason, fmt.Sprintf("init container; %s (image %s, restarts %d)", w.Message, cs.Image, cs.RestartCount))
			} else if t := cs.State.Terminated; t != nil && t.ExitCode != 0 {
				add(8, cobj, "Init:"+t.Reason, fmt.Sprintf("init container exited %d", t.ExitCode))
			}
		}
		for _, cs := range p.Status.ContainerStatuses {
			cobj := obj + "/" + cs.Name
			if w := cs.State.Waiting; w != nil && w.Reason != "" && w.Reason != "ContainerCreating" {
				sev := 7
				switch w.Reason {
				case "CrashLoopBackOff":
					sev = 9
				case "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError", "InvalidImageName":
					sev = 9
				}
				add(sev, cobj, w.Reason, fmt.Sprintf("%s (image %s)", w.Message, cs.Image))
			}
			if t := cs.LastState.Terminated; t != nil && t.Reason == "OOMKilled" {
				// an old OOM kill on a ready container is history, not a problem now
				a, known := age(t.FinishedAt, now)
				switch {
				case !cs.Ready || !known || a <= Recent:
					add(9, cobj, "OOMKilled", fmt.Sprintf("last exit %d, restarts %d", t.ExitCode, cs.RestartCount))
				case a <= 24*time.Hour:
					add(5, cobj, "OOMKilledEarlier", fmt.Sprintf("OOM-killed %s ago, ready since; restarts %d", a.Round(time.Minute), cs.RestartCount))
				}
			} else if t != nil && t.ExitCode != 0 && cs.RestartCount > 0 {
				// a crash long ago on a container that is fine since is history
				if a, known := age(t.FinishedAt, now); !cs.Ready || !known || a <= Recent {
					add(6, cobj, "Terminated", fmt.Sprintf("%s exit %d, restarts %d", t.Reason, t.ExitCode, cs.RestartCount))
				}
			}
			if cs.RestartCount >= 5 {
				// restarts count up for the container's life: only while it last restarted within a day
				lastRestart := ""
				if lt := cs.LastState.Terminated; lt != nil {
					lastRestart = lt.FinishedAt
				}
				if a, known := age(lastRestart, now); !known || a <= 24*time.Hour {
					add(5, cobj, "HighRestarts", fmt.Sprintf("%d restarts", cs.RestartCount))
				}
			}
			if !cs.Ready && p.Status.Phase == "Running" && cs.State.Waiting == nil {
				add(5, cobj, "NotReady", "running but readiness failing")
			}
		}
	}
	sort.SliceStable(rep.Findings, func(i, j int) bool { return rep.Findings[i].Severity > rep.Findings[j].Severity })
	ev, err := c.Events(ctx, s, true)
	if err == nil {
		if len(ev) > 30 {
			ev = ev[:30]
		}
		rep.Warnings = ev
	}
	if rep.Findings == nil {
		rep.Findings = []Finding{}
	}
	rep.Hint = "Correlate with Argo CD sync history (argo_app_tree), recent Git commits, and Prometheus/Grafana metrics (restarts, memory vs limits, error rate) before concluding."
	return rep, nil
}

// Top keeps the n most severe findings (they are sorted already); the rest
// are counted in Truncated.
func (r *RCAReport) Top(n int) {
	if len(r.Findings) > n {
		r.Truncated = len(r.Findings) - n
		r.Findings = r.Findings[:n]
	}
}
