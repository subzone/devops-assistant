package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
)

// Finding is one RCA signal, ranked by severity (higher first).
type Finding struct {
	Severity int    `json:"severity"`
	Object   string `json:"object"`
	Signal   string `json:"signal"`
	Detail   string `json:"detail"`
}

type RCAReport struct {
	Context   string    `json:"context"`
	Namespace string    `json:"namespace"`
	Findings  []Finding `json:"findings"`
	Warnings  []Event   `json:"recentWarnings"`
	Hint      string    `json:"hint"`
}

type podList struct {
	Items []struct {
		Metadata struct {
			Name            string
			OwnerReferences []struct{ Kind, Name string }
		} `json:"metadata"`
		Spec struct {
			NodeName string
		} `json:"spec"`
		Status struct {
			Phase             string
			Reason            string
			Conditions        []struct{ Type, Status, Reason, Message string }
			ContainerStatuses []struct {
				Name         string
				Ready        bool
				RestartCount int
				Image        string
				State        struct {
					Waiting    *struct{ Reason, Message string }
					Terminated *struct {
						Reason   string
						ExitCode int
					}
				}
				LastState struct {
					Terminated *struct {
						Reason   string
						ExitCode int
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
	add := func(sev int, obj, sig, det string) {
		rep.Findings = append(rep.Findings, Finding{sev, obj, sig, det})
	}
	for _, p := range pl.Items {
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
			add(7, obj, "Failed", p.Status.Reason)
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
				add(9, cobj, "OOMKilled", fmt.Sprintf("last exit %d, restarts %d", t.ExitCode, cs.RestartCount))
			} else if t != nil && t.ExitCode != 0 && cs.RestartCount > 0 {
				add(6, cobj, "Terminated", fmt.Sprintf("%s exit %d, restarts %d", t.Reason, t.ExitCode, cs.RestartCount))
			}
			if cs.RestartCount >= 5 {
				add(5, cobj, "HighRestarts", fmt.Sprintf("%d restarts", cs.RestartCount))
			}
			if !cs.Ready && p.Status.Phase == "Running" && cs.State.Waiting == nil {
				add(5, cobj, "NotReady", "running but readiness failing")
			}
		}
	}
	sort.SliceStable(rep.Findings, func(i, j int) bool { return rep.Findings[i].Severity > rep.Findings[j].Severity })
	if len(rep.Findings) > 50 {
		rep.Findings = rep.Findings[:50]
	}
	ev, err := c.Events(ctx, s, true)
	if err == nil {
		if len(ev) > 30 {
			ev = ev[:30]
		}
		rep.Warnings = ev
	}
	rep.Hint = "Correlate with Argo CD sync history (argo_app_tree), recent Git commits, and Prometheus/Grafana metrics (restarts, memory vs limits, error rate) before concluding."
	return rep, nil
}
