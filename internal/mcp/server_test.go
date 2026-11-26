package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/subzone/devops-assistant/internal/config"
	"github.com/subzone/devops-assistant/internal/grant"
	"github.com/subzone/devops-assistant/internal/kube"
)

func newTestServer(t *testing.T, calls *[][]string) *Server {
	home := t.TempDir()
	k := &kube.Client{Kubectl: "kubectl", Exec: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		*calls = append(*calls, args)
		return []byte(`{}`), nil
	}}
	s := NewServer("k8sh", "test")
	Register(s, Deps{Home: home, Kube: k, Grants: grant.NewStore(home), Config: &config.Config{Contexts: map[string]config.Context{}}})
	return s
}

func roundTrip(t *testing.T, s *Server, lines ...string) []map[string]any {
	var out bytes.Buffer
	if err := s.Serve(context.Background(), strings.NewReader(strings.Join(lines, "\n")+"\n"), &out); err != nil {
		t.Fatal(err)
	}
	var res []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		json.Unmarshal([]byte(l), &m)
		res = append(res, m)
	}
	return res
}

func TestInitializeAndList(t *testing.T) {
	var calls [][]string
	s := newTestServer(t, &calls)
	res := roundTrip(t, s,
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	if len(res) != 2 {
		t.Fatalf("want 2 responses, got %d", len(res))
	}
	b, _ := json.Marshal(res)
	for _, name := range []string{"k8s_get", "rca_collect", "destructive_delete", "lock_status"} {
		if !strings.Contains(string(b), name) {
			t.Errorf("tool %s missing", name)
		}
	}
}

func TestDestructiveLockedWithoutGrant(t *testing.T) {
	var calls [][]string
	s := newTestServer(t, &calls)
	res := roundTrip(t, s, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"destructive_delete","arguments":{"context":"eks-prod","namespace":"pay","target":"pod/api-1"}}}`)
	r := res[0]["result"].(map[string]any)
	if r["isError"] != true {
		t.Fatal("destructive call succeeded without grant")
	}
	txt := r["content"].([]any)[0].(map[string]any)["text"].(string)
	if !strings.Contains(txt, "LOCKED") || !strings.Contains(txt, "k8sh unlock") {
		t.Fatalf("unexpected message: %s", txt)
	}
	for _, c := range calls {
		if strings.Contains(strings.Join(c, " "), "delete") {
			t.Fatal("kubectl delete executed while locked")
		}
	}
}
