package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/subzone/k8s-handler/internal/kube"
)

// Status classes drive the icon/colour.
const (
	stOK   = "ok"
	stWarn = "warn"
	stErr  = "err"
	stNone = ""
)

type node struct {
	label    string
	status   string
	kind     string // Namespace, Deployment, Pod, Container, App, Resource, Finding, Grant, Info
	ns, name string
	pod      string // for containers
	detail   []string
	level    int
	expanded bool
	loaded   bool
	children []*node
	load     func() ([]*node, error)
	parent   *node
}

func (n *node) expandable() bool { return n.load != nil || len(n.children) > 0 }

// --- generic JSON helpers ---

func dig(m any, path ...string) any {
	for _, p := range path {
		mm, ok := m.(map[string]any)
		if !ok {
			return nil
		}
		m = mm[p]
	}
	return m
}
func str(m any, path ...string) string { s, _ := dig(m, path...).(string); return s }
func num(m any, path ...string) int {
	switch v := dig(m, path...).(type) {
	case float64:
		return int(v)
	}
	return 0
}
func items(b []byte) []any {
	var l map[string]any
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	it, _ := l["items"].([]any)
	return it
}

type loader struct {
	k   *kube.Client
	ctx context.Context
}

func (l *loader) sc(kctx, ns string) kube.Scope { return kube.Scope{Context: kctx, Namespace: ns} }

// ---------- Cluster view ----------

func (l *loader) namespaces(kctx string) ([]*node, error) {
	b, err := l.k.GetJSON(l.ctx, l.sc(kctx, ""), "namespaces", "", "", false)
	if err != nil {
		return nil, err
	}
	var out []*node
	for _, it := range items(b) {
		name := str(it, "metadata", "name")
		ns := name
		st := stOK
		if str(it, "status", "phase") != "Active" {
			st = stWarn
		}
		n := &node{label: name, status: st, kind: "Namespace", ns: ns, name: name,
			detail: []string{"Namespace " + name, "phase: " + str(it, "status", "phase"), "created: " + str(it, "metadata", "creationTimestamp")}}
		n.load = func() ([]*node, error) { return l.workloads(kctx, ns) }
		out = append(out, n)
	}
	return out, nil
}

type podInfo struct {
	raw    any
	labels map[string]string
	used   bool
}

func (l *loader) workloads(kctx, ns string) ([]*node, error) {
	wb, err := l.k.GetJSON(l.ctx, l.sc(kctx, ns), "deployments,statefulsets,daemonsets", "", "", false)
	if err != nil {
		return nil, err
	}
	pb, err := l.k.GetJSON(l.ctx, l.sc(kctx, ns), "pods", "", "", false)
	if err != nil {
		return nil, err
	}
	var pods []*podInfo
	for _, p := range items(pb) {
		lbl := map[string]string{}
		if m, ok := dig(p, "metadata", "labels").(map[string]any); ok {
			for k, v := range m {
				lbl[k], _ = v.(string)
			}
		}
		pods = append(pods, &podInfo{raw: p, labels: lbl})
	}
	var out []*node
	for _, w := range items(wb) {
		kind := str(w, "kind")
		name := str(w, "metadata", "name")
		var want, ready int
		switch kind {
		case "DaemonSet":
			want, ready = num(w, "status", "desiredNumberScheduled"), num(w, "status", "numberReady")
		default:
			want, ready = num(w, "spec", "replicas"), num(w, "status", "readyReplicas")
		}
		st := stOK
		if ready < want {
			st = stWarn
			if ready == 0 && want > 0 {
				st = stErr
			}
		}
		sel := map[string]string{}
		if m, ok := dig(w, "spec", "selector", "matchLabels").(map[string]any); ok {
			for k, v := range m {
				sel[k], _ = v.(string)
			}
		}
		n := &node{label: fmt.Sprintf("%s/%s  %d/%d", short(kind), name, ready, want), status: st, kind: kind, ns: ns, name: name}
		n.detail = []string{kind + " " + ns + "/" + name, fmt.Sprintf("ready: %d/%d", ready, want)}
		for _, c := range asList(dig(w, "spec", "template", "spec", "containers")) {
			n.detail = append(n.detail, "image: "+str(c, "image"))
		}
		n.detail = append(n.detail, conditions(w)...)
		var kids []*node
		for _, p := range pods {
			if len(sel) > 0 && matches(sel, p.labels) {
				p.used = true
				kids = append(kids, podNode(p.raw, ns))
			}
		}
		n.children = kids
		n.loaded = true
		out = append(out, n)
	}
	for _, p := range pods {
		if !p.used {
			out = append(out, podNode(p.raw, ns))
		}
	}
	if len(out) == 0 {
		out = append(out, &node{label: "(empty)", kind: "Info"})
	}
	return out, nil
}

func short(kind string) string {
	switch kind {
	case "Deployment":
		return "deploy"
	case "StatefulSet":
		return "sts"
	case "DaemonSet":
		return "ds"
	}
	return strings.ToLower(kind)
}

func asList(v any) []any { l, _ := v.([]any); return l }

func matches(sel, lbl map[string]string) bool {
	for k, v := range sel {
		if lbl[k] != v {
			return false
		}
	}
	return true
}

func conditions(o any) []string {
	var out []string
	for _, c := range asList(dig(o, "status", "conditions")) {
		line := fmt.Sprintf("condition %s=%s", str(c, "type"), str(c, "status"))
		if r := str(c, "reason"); r != "" {
			line += " (" + r + ")"
		}
		out = append(out, line)
	}
	return out
}

func podNode(p any, ns string) *node {
	name := str(p, "metadata", "name")
	phase := str(p, "status", "phase")
	st := stOK
	restarts := 0
	reason := ""
	var kids []*node
	for _, cs := range asList(dig(p, "status", "containerStatuses")) {
		cst := stOK
		cname := str(cs, "name")
		r := num(cs, "restartCount")
		restarts += r
		state := "running"
		if w := str(cs, "state", "waiting", "reason"); w != "" {
			state, cst = w, stErr
			reason = w
		} else if t := str(cs, "state", "terminated", "reason"); t != "" {
			state = "terminated: " + t
			if t != "Completed" {
				cst = stErr
			}
		}
		if ready, _ := dig(cs, "ready").(bool); !ready && cst == stOK && phase == "Running" {
			cst = stWarn
		}
		last := str(cs, "lastState", "terminated", "reason")
		if last == "OOMKilled" {
			cst = stErr
			reason = "OOMKilled"
		}
		if cst == stErr || (cst == stWarn && st == stOK) {
			st = cst
		}
		det := []string{"Container " + cname + " in pod " + ns + "/" + name, "image: " + str(cs, "image"), "state: " + state, fmt.Sprintf("restarts: %d", r)}
		if last != "" {
			det = append(det, "last termination: "+last)
		}
		kids = append(kids, &node{label: fmt.Sprintf("%s  %s  r:%d", cname, state, r), status: cst, kind: "Container", ns: ns, name: cname, pod: name, detail: det})
	}
	if phase == "Pending" || phase == "Failed" || phase == "Unknown" {
		st = stErr
		if phase == "Pending" {
			st = stWarn
		}
	}
	if phase == "Succeeded" {
		st = stNone
	}
	label := fmt.Sprintf("pod/%s  %s", name, phase)
	if reason != "" {
		label += " " + reason
	}
	if restarts > 0 {
		label += fmt.Sprintf(" r:%d", restarts)
	}
	det := []string{"Pod " + ns + "/" + name, "phase: " + phase, "node: " + str(p, "spec", "nodeName"), fmt.Sprintf("restarts: %d", restarts)}
	det = append(det, conditions(p)...)
	det = append(det, "", "keys: e events · l logs · f send to Claude · u unlock action")
	return &node{label: label, status: st, kind: "Pod", ns: ns, name: name, detail: det, children: kids, loaded: true}
}

// ---------- Argo view ----------

func (l *loader) argoApps(kctx string) ([]*node, error) {
	apps, err := l.k.ArgoApps(l.ctx, l.sc(kctx, "argocd"))
	if err != nil {
		if strings.Contains(err.Error(), "doesn't have a resource type") || strings.Contains(err.Error(), "NotFound") || strings.Contains(err.Error(), "not found") {
			return []*node{{label: "Argo CD not installed in this context (no applications.argoproj.io)", kind: "Info"}}, nil
		}
		return nil, err
	}
	if len(apps) == 0 {
		return []*node{{label: "(no Argo CD applications)", kind: "Info"}}, nil
	}
	sort.Slice(apps, func(i, j int) bool {
		return rank(apps[i]) > rank(apps[j]) || (rank(apps[i]) == rank(apps[j]) && apps[i].Name < apps[j].Name)
	})
	var out []*node
	for _, a := range apps {
		a := a
		st := stOK
		if a.Sync != "Synced" {
			st = stWarn
		}
		if a.Health == "Degraded" || a.Health == "Missing" {
			st = stErr
		}
		n := &node{label: fmt.Sprintf("%s  %s/%s", a.Name, a.Sync, a.Health), status: st, kind: "Application", ns: "argocd", name: a.Name,
			detail: []string{"Application " + a.Name, "project: " + a.Project, "sync: " + a.Sync, "health: " + a.Health, "revision: " + a.Revision,
				"repo: " + a.Repo, "path: " + a.Path, "destination: " + a.DestServer + " / " + a.DestNS,
				fmt.Sprintf("auto-sync: %v  auto-prune: %v", a.AutoSync, a.AutoPrune), "last operation: " + a.OperationOK}}
		n.load = func() ([]*node, error) {
			_, res, err := l.k.ArgoAppTree(l.ctx, l.sc(kctx, "argocd"), a.Name)
			if err != nil {
				return nil, err
			}
			var kids []*node
			for _, r := range res {
				rs := stOK
				if r.Status != "Synced" {
					rs = stWarn
				}
				if r.Health == "Degraded" || r.Health == "Missing" {
					rs = stErr
				}
				lbl := fmt.Sprintf("%s/%s  %s", r.Kind, r.Name, r.Status)
				if r.Health != "" {
					lbl += "/" + r.Health
				}
				kids = append(kids, &node{label: lbl, status: rs, kind: r.Kind, ns: r.Namespace, name: r.Name,
					detail: []string{r.Kind + " " + r.Namespace + "/" + r.Name, "sync: " + r.Status, "health: " + r.Health, r.Message}})
			}
			return kids, nil
		}
		out = append(out, n)
	}
	return out, nil
}

func rank(a kube.ArgoApp) int {
	switch {
	case a.Health == "Degraded" || a.Health == "Missing":
		return 2
	case a.Sync != "Synced" || a.Health != "Healthy":
		return 1
	}
	return 0
}

// ---------- RCA view ----------

func (l *loader) rca(kctx string) ([]*node, error) {
	r, err := l.k.RCA(l.ctx, l.sc(kctx, ""))
	if err != nil {
		return nil, err
	}
	var out []*node
	for _, f := range r.Findings {
		st := stWarn
		if f.Severity >= 8 {
			st = stErr
		}
		out = append(out, &node{label: fmt.Sprintf("[%d] %s  %s", f.Severity, f.Signal, f.Object), status: st, kind: "Finding", name: f.Object,
			detail: []string{"Finding: " + f.Signal, "object: " + f.Object, "severity: " + fmt.Sprint(f.Severity), "", f.Detail, "", "f: send to Claude for RCA"}})
	}
	if len(out) == 0 {
		out = append(out, &node{label: "no problem signals in pods", status: stOK, kind: "Info"})
	}
	if len(r.Warnings) > 0 {
		w := &node{label: fmt.Sprintf("recent warnings (%d)", len(r.Warnings)), status: stWarn, kind: "Info", loaded: true}
		for _, e := range r.Warnings {
			w.children = append(w.children, &node{label: e.Reason + "  " + e.Object, status: stWarn, kind: "Event", name: e.Object,
				detail: []string{"Event " + e.Reason, "object: " + e.Object, "last: " + e.Last, fmt.Sprintf("count: %d", e.Count), "", e.Message}})
		}
		out = append(out, w)
	}
	return out, nil
}
