package kube

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// kubectl answers by the resource asked for.
func byKind(answers map[string]string) Exec {
	return func(_ context.Context, _ string, args ...string) ([]byte, error) {
		for i, a := range args {
			if a == "get" && i+1 < len(args) {
				if out, ok := answers[args[i+1]]; ok {
					return []byte(out), nil
				}
			}
		}
		return []byte(`{"items":[]}`), nil
	}
}

func TestSummary(t *testing.T) {
	now := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	c := &Client{Kubectl: "kubectl", Exec: byKind(map[string]string{
		"nodes": `{"items":[{"metadata":{"name":"n1"},"status":{"conditions":[{"type":"Ready","status":"True"}]}},{"metadata":{"name":"n2"},"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}`,
		"pods": `{"items":[
			{"metadata":{"name":"ok","namespace":"a"},"status":{"phase":"Running","containerStatuses":[{"name":"c","ready":true,"state":{"running":{}}}]}},
			{"metadata":{"name":"crash","namespace":"a"},"status":{"phase":"Running","containerStatuses":[{"name":"c","state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}},
			{"metadata":{"name":"init","namespace":"b"},"status":{"phase":"Pending","initContainerStatuses":[{"name":"wait","state":{"waiting":{"reason":"CrashLoopBackOff"}}}],"containerStatuses":[{"name":"c","state":{"waiting":{"reason":"PodInitializing"}}}]}},
			{"metadata":{"name":"starting","namespace":"b"},"status":{"phase":"Pending","containerStatuses":[{"name":"c","state":{"waiting":{"reason":"ContainerCreating"}}}]}},
			{"metadata":{"name":"job","namespace":"b"},"status":{"phase":"Succeeded"}}]}`,
		"events":                   `{"items":[{"type":"Warning","reason":"BackOff","lastTimestamp":"2026-11-27T09:55:00Z","involvedObject":{"kind":"Pod","name":"crash","namespace":"a"}},{"type":"Warning","reason":"Old","lastTimestamp":"2026-11-27T08:00:00Z","involvedObject":{"kind":"Pod","name":"x"}}]}`,
		"applications.argoproj.io": `{"items":[{"metadata":{"name":"web"},"status":{"sync":{"status":"Synced"},"health":{"status":"Healthy"}}},{"metadata":{"name":"pay"},"status":{"sync":{"status":"OutOfSync"},"health":{"status":"Degraded"}}}]}`,
	})}
	s := c.Summary(context.Background(), "dev", now)
	if !s.Reachable || s.Nodes != 2 || s.NodesReady != 1 || s.Pods != 5 || s.PodsFailing != 2 || s.PodsNotReady != 1 || s.Warnings != 1 {
		t.Fatalf("summary: %+v", s)
	}
	joined := strings.Join(s.TopProblems, "\n")
	for _, want := range []string{"node/n2: NotReady", "a/pod/crash: CrashLoopBackOff", "b/pod/init: Init:CrashLoopBackOff"} {
		if !strings.Contains(joined, want) {
			t.Errorf("top problems lack %q: %v", want, s.TopProblems)
		}
	}
	if s.ArgoInstalled && (s.ArgoApps != 2 || s.ArgoDegraded != 1) {
		t.Errorf("argo: %+v", s)
	}
}

func TestFleetUnreachableAndBadName(t *testing.T) {
	c := &Client{Kubectl: "kubectl", Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if args[1] == "gone" {
			return nil, context.DeadlineExceeded
		}
		return []byte(`{"items":[]}`), nil
	}}
	out := c.Fleet(context.Background(), []string{"dev", "gone", "x;rm"}, time.Second)
	if !out[0].Reachable || out[1].Reachable || out[1].Error == "" || out[2].Reachable || !strings.Contains(out[2].Error, "invalid") {
		t.Fatalf("fleet: %+v", out)
	}
}

func TestSecurity(t *testing.T) {
	c := &Client{Kubectl: "kubectl", Exec: byKind(map[string]string{
		"pods": `{"items":[
			{"metadata":{"name":"api-7d9-a","namespace":"payments","labels":{"pod-template-hash":"7d9"},"ownerReferences":[{"kind":"ReplicaSet","name":"api-7d9","controller":true}]},
			 "spec":{"containers":[{"name":"app","image":"ghcr.io/acme/api:latest","securityContext":{"privileged":true}}]},"status":{"phase":"Running"}},
			{"metadata":{"name":"api-7d9-b","namespace":"payments","labels":{"pod-template-hash":"7d9"},"ownerReferences":[{"kind":"ReplicaSet","name":"api-7d9","controller":true}]},
			 "spec":{"containers":[{"name":"app","image":"ghcr.io/acme/api:latest","securityContext":{"privileged":true}}]},"status":{"phase":"Running"}},
			{"metadata":{"name":"good","namespace":"web"},
			 "spec":{"securityContext":{"runAsNonRoot":true},"containers":[{"name":"app","image":"nginx@sha256:abc","resources":{"limits":{"memory":"128Mi"}},"securityContext":{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"add":["NET_BIND_SERVICE"]}}}]},"status":{"phase":"Running"}},
			{"metadata":{"name":"agent","namespace":"kube-system"},"spec":{"hostNetwork":true,"containers":[{"name":"a","image":"agent:1"}]},"status":{"phase":"Running"}}]}`,
		"networkpolicies":     `{"items":[{"metadata":{"namespace":"web"}}]}`,
		"clusterrolebindings": `{"items":[{"metadata":{"name":"ops"},"roleRef":{"name":"cluster-admin"},"subjects":[{"kind":"User","name":"bob"},{"kind":"Group","name":"system:masters"}]},{"metadata":{"name":"view"},"roleRef":{"name":"view"},"subjects":[{"kind":"User","name":"amy"}]}]}`,
	})}
	r, err := c.Security(context.Background(), Scope{Context: "dev"}, false)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]SecurityCheck{}
	for _, ch := range r.Checks {
		got[ch.ID] = ch
	}
	if ch := got["privileged"]; ch.Count != 1 || ch.Objects[0] != "payments/deployment/api" {
		t.Errorf("privileged deduped per workload: %+v", ch)
	}
	if ch := got["cluster-admin"]; ch.Count != 1 || !strings.Contains(ch.Objects[0], "user/bob") {
		t.Errorf("cluster-admin: %+v", ch)
	}
	if ch := got["no-network-policy"]; ch.Count != 1 || ch.Objects[0] != "payments/namespace/payments" {
		t.Errorf("netpol: %+v", ch)
	}
	if ch := got["latest-tag"]; ch.Count != 1 {
		t.Errorf("latest tag: %+v", ch)
	}
	if _, ok := got["host-namespaces"]; ok {
		t.Error("kube-system counted without includeSystem")
	}
	for _, id := range []string{"run-as-root", "privilege-escalation", "writable-root-fs", "no-memory-limit"} {
		for _, o := range got[id].Objects {
			if strings.HasPrefix(o, "web/") {
				t.Errorf("%s flags the hardened pod", id)
			}
		}
	}
	if r.Checks[0].Severity != "high" || r.Summary["high"] != 2 {
		t.Errorf("order/summary: %+v %v", r.Checks[0], r.Summary)
	}

	withSys, _ := c.Security(context.Background(), Scope{Context: "dev"}, true)
	found := false
	for _, ch := range withSys.Checks {
		found = found || ch.ID == "host-namespaces"
	}
	if !found {
		t.Error("includeSystem missed kube-system")
	}
}

func TestRCAFindingsCarryNamespaceAndAreAllKept(t *testing.T) {
	items := []string{}
	for i := 0; i < 60; i++ {
		items = append(items, `{"metadata":{"name":"p`+string(rune('a'+i%26))+string(rune('a'+i/26))+`","namespace":"ns1"},"status":{"phase":"Pending"}}`)
	}
	c := &Client{Kubectl: "kubectl", Exec: byKind(map[string]string{"pods": `{"items":[` + strings.Join(items, ",") + `]}`})}
	r, err := c.RCA(context.Background(), Scope{Context: "dev"})
	if err != nil || len(r.Findings) != 60 || r.Findings[0].Namespace != "ns1" {
		t.Fatalf("rca: %d %v", len(r.Findings), err)
	}
	r.Top(50)
	if len(r.Findings) != 50 || r.Truncated != 10 {
		t.Fatalf("top: %d %d", len(r.Findings), r.Truncated)
	}
}

// Past problems age out: an old OOM kill on a ready container, a Job run
// that failed hours ago and an evicted leftover are not failing pods now.
func TestPastProblemsAgeOut(t *testing.T) {
	now := time.Date(2026, 11, 27, 12, 0, 0, 0, time.UTC)
	at := func(d time.Duration) string { return now.Add(-d).Format(time.RFC3339) }
	pods := `{"items":[
		{"metadata":{"name":"old-oom","namespace":"a"},"status":{"phase":"Running","containerStatuses":[{"name":"c","ready":true,"state":{"running":{}},"lastState":{"terminated":{"reason":"OOMKilled","finishedAt":"` + at(240*time.Hour) + `"}}}]}},
		{"metadata":{"name":"today-oom","namespace":"a"},"status":{"phase":"Running","containerStatuses":[{"name":"c","ready":true,"state":{"running":{}},"lastState":{"terminated":{"reason":"OOMKilled","finishedAt":"` + at(5*time.Hour) + `"}}}]}},
		{"metadata":{"name":"fresh-oom","namespace":"a"},"status":{"phase":"Running","containerStatuses":[{"name":"c","ready":true,"state":{"running":{}},"lastState":{"terminated":{"reason":"OOMKilled","finishedAt":"` + at(10*time.Minute) + `"}}}]}},
		{"metadata":{"name":"old-job","namespace":"a","ownerReferences":[{"kind":"Job","name":"backup","controller":true}]},"status":{"phase":"Failed","containerStatuses":[{"name":"c","state":{"terminated":{"reason":"Error","exitCode":1,"finishedAt":"` + at(3*time.Hour) + `"}}}]}},
		{"metadata":{"name":"new-job","namespace":"a","ownerReferences":[{"kind":"Job","name":"backup","controller":true}]},"status":{"phase":"Failed","containerStatuses":[{"name":"c","state":{"terminated":{"reason":"Error","exitCode":1,"finishedAt":"` + at(5*time.Minute) + `"}}}]}},
		{"metadata":{"name":"evicted","namespace":"a"},"status":{"phase":"Failed","reason":"Evicted"}},
		{"metadata":{"name":"stuck","namespace":"a"},"status":{"phase":"Pending","initContainerStatuses":[{"name":"wait","state":{"waiting":{"reason":"CrashLoopBackOff"}}}],"containerStatuses":[{"name":"c","state":{"waiting":{"reason":"PodInitializing"}}}]}}]}`
	var pl podList2
	if err := json.Unmarshal([]byte(pods), &pl); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"stuck": "err", "old-oom": "ok", "today-oom": "warn", "fresh-oom": "err", "old-job": "done", "new-job": "err", "evicted": "warn"}
	for _, p := range pl.Items {
		if st, reason := p.health(now); st != want[p.Metadata.Name] {
			t.Errorf("%s: %s (%s), want %s", p.Metadata.Name, st, reason, want[p.Metadata.Name])
		}
	}

	c := &Client{Kubectl: "kubectl", Exec: byKind(map[string]string{"pods": pods}), Now: func() time.Time { return now }}
	r, err := c.RCA(context.Background(), Scope{Context: "dev", Namespace: "a"})
	if err != nil {
		t.Fatal(err)
	}
	sig := map[string]string{}
	for _, f := range r.Findings {
		sig[f.Object] = f.Signal
	}
	if _, ok := sig["pod/old-oom/c"]; ok {
		t.Error("a 10-day-old OOM kill is a finding")
	}
	if sig["pod/today-oom/c"] != "OOMKilledEarlier" || sig["pod/fresh-oom/c"] != "OOMKilled" {
		t.Errorf("oom signals: %v", sig)
	}
	if _, ok := sig["pod/old-job"]; ok {
		t.Error("an old failed Job run is a finding")
	}
	if sig["pod/stuck/wait"] != "Init:CrashLoopBackOff" {
		t.Errorf("init container: %v", sig)
	}
	if sig["pod/new-job"] != "Failed" || sig["pod/evicted"] != "Evicted" {
		t.Errorf("failed/evicted: %v", sig)
	}
}
