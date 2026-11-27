package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// ClusterSummary is one context at a glance, for the fleet view.
type ClusterSummary struct {
	Context       string   `json:"context"`
	Reachable     bool     `json:"reachable"`
	Error         string   `json:"error,omitempty"`
	Nodes         int      `json:"nodes"`
	NodesReady    int      `json:"nodesReady"`
	Pods          int      `json:"pods"`
	PodsFailing   int      `json:"podsFailing"`
	PodsNotReady  int      `json:"podsNotReady"`
	Warnings      int      `json:"warnings15m"`
	ArgoInstalled bool     `json:"argoInstalled"`
	ArgoApps      int      `json:"argoApps"`
	ArgoDegraded  int      `json:"argoDegraded"`
	ArgoOutOfSync int      `json:"argoOutOfSync"`
	TopProblems   []string `json:"topProblems"`
}

// Summary reads one context: nodes, pods (all namespaces), warning events of
// the last 15 minutes and Argo CD apps. An unreachable cluster is a summary
// with Reachable false and the error, not an error.
func (c *Client) Summary(ctx context.Context, kubeCtx string, now time.Time) ClusterSummary {
	s := ClusterSummary{Context: kubeCtx, TopProblems: []string{}}
	sc := Scope{Context: kubeCtx}

	nb, err := c.GetJSON(ctx, sc, "nodes", "", "", false)
	if err != nil {
		s.Error = err.Error()
		return s
	}
	s.Reachable = true
	var nodes struct {
		Items []struct {
			Metadata struct{ Name string } `json:"metadata"`
			Status   struct {
				Conditions []struct{ Type, Status string }
			} `json:"status"`
		}
	}
	if json.Unmarshal(nb, &nodes) == nil {
		for _, n := range nodes.Items {
			s.Nodes++
			ready := false
			for _, cd := range n.Status.Conditions {
				if cd.Type == "Ready" && cd.Status == "True" {
					ready = true
				}
			}
			if ready {
				s.NodesReady++
			} else {
				s.TopProblems = append(s.TopProblems, "node/"+n.Metadata.Name+": NotReady")
			}
		}
	}

	if pb, err := c.GetJSON(ctx, sc, "pods", "", "", true); err == nil {
		var pl podList2
		if json.Unmarshal(pb, &pl) == nil {
			var bad []string
			for _, p := range pl.Items {
				s.Pods++
				st, reason := p.health(now)
				switch st {
				case "err":
					s.PodsFailing++
					bad = append(bad, fmt.Sprintf("%s/pod/%s: %s", p.Metadata.Namespace, p.Metadata.Name, reason))
				case "warn":
					s.PodsNotReady++
				}
			}
			sort.Strings(bad)
			s.TopProblems = append(s.TopProblems, bad...)
		}
	}

	if ev, err := c.Events(ctx, sc, true); err == nil {
		for _, e := range ev {
			if t, err := time.Parse(time.RFC3339, e.Last); err == nil && now.Sub(t) <= 15*time.Minute {
				s.Warnings++
			}
		}
	}

	if apps, err := c.ArgoApps(ctx, sc); err == nil {
		s.ArgoInstalled = true
		for _, a := range apps {
			s.ArgoApps++
			if a.Health == "Degraded" || a.Health == "Missing" {
				s.ArgoDegraded++
				s.TopProblems = append(s.TopProblems, "app/"+a.Name+": "+a.Health)
			} else if a.Sync != "Synced" {
				s.ArgoOutOfSync++
			}
		}
	}

	if len(s.TopProblems) > 5 {
		s.TopProblems = s.TopProblems[:5]
	}
	return s
}

// Fleet summarizes several contexts at once, each within its own time limit,
// in the order given.
func (c *Client) Fleet(ctx context.Context, contexts []string, perContext time.Duration) []ClusterSummary {
	out := make([]ClusterSummary, len(contexts))
	var wg sync.WaitGroup
	now := c.now()
	for i, kc := range contexts {
		wg.Add(1)
		go func(i int, kc string) {
			defer wg.Done()
			if err := check("context", kc); err != nil {
				out[i] = ClusterSummary{Context: kc, Error: err.Error(), TopProblems: []string{}}
				return
			}
			cctx, cancel := context.WithTimeout(ctx, perContext)
			defer cancel()
			out[i] = c.Summary(cctx, kc, now)
		}(i, kc)
	}
	wg.Wait()
	return out
}
