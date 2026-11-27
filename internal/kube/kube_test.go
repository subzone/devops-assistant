package kube

import (
	"context"
	"strings"
	"testing"
)

func fake(out string, got *[]string) Exec {
	return func(_ context.Context, name string, args ...string) ([]byte, error) {
		*got = append([]string{name}, args...)
		return []byte(out), nil
	}
}

func TestGetRedactsSecrets(t *testing.T) {
	var got []string
	c := &Client{Kubectl: "kubectl", Exec: fake(`{"kind":"Secret","data":{"pw":"aHVudGVy"}}`, &got)}
	b, err := c.GetJSON(context.Background(), Scope{Context: "dev", Namespace: "a"}, "secret", "db", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "aHVudGVy") {
		t.Fatal("secret value leaked")
	}
	if strings.Join(got, " ") != "kubectl --context dev -n a get secret db -o json" {
		t.Fatalf("unexpected args: %v", got)
	}
}

// kubectl 1.37 takes --all-namespaces only after the verb.
func TestAllNamespacesAfterVerb(t *testing.T) {
	var got []string
	c := &Client{Kubectl: "kubectl", Exec: fake(`{"items":[]}`, &got)}
	if _, err := c.GetJSON(context.Background(), Scope{Context: "dev", Namespace: "ignored"}, "pods", "", "", true); err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, " ") != "kubectl --context dev get pods --all-namespaces -o json" {
		t.Fatalf("unexpected args: %v", got)
	}
}

func TestFlagInjectionRejected(t *testing.T) {
	var got []string
	c := &Client{Kubectl: "kubectl", Exec: fake("{}", &got)}
	for _, bad := range []string{"--raw", "-o", "a b", "x;rm"} {
		if _, err := c.GetJSON(context.Background(), Scope{Context: "dev"}, "pods", bad, "", false); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestRCAFindings(t *testing.T) {
	pods := `{"items":[{"metadata":{"name":"api-1"},"status":{"phase":"Running","containerStatuses":[{"name":"api","restartCount":7,"image":"api:1.42","state":{"waiting":{"reason":"CrashLoopBackOff","message":"back-off"}},"lastState":{"terminated":{"reason":"OOMKilled","exitCode":137}}}]}}]}`
	calls := 0
	c := &Client{Kubectl: "kubectl", Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		calls++
		if calls == 1 {
			return []byte(pods), nil
		}
		return []byte(`{"items":[]}`), nil
	}}
	r, err := c.RCA(context.Background(), Scope{Context: "dev", Namespace: "a"})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Findings) < 2 || r.Findings[0].Severity != 9 {
		t.Fatalf("unexpected findings: %+v", r.Findings)
	}
}
