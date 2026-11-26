package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/subzone/k8s-handler/internal/config"
	"github.com/subzone/k8s-handler/internal/grant"
)

func uiHome(t *testing.T) (string, string) {
	t.Helper()
	t.Setenv("K8SH_AGENT", "")
	home := t.TempDir()
	p, err := grant.EnsureUIToken(home)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	return home, strings.TrimSpace(string(b))
}

func runUI(home, token string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	cfg := &config.Config{Contexts: map[string]config.Context{"k3d-mycluster": {Tier: config.TierDev}}}
	code := grantFromUI(home, cfg, args, strings.NewReader(token+"\n"), &out, &errb)
	return code, out.String(), errb.String()
}

var podArgs = []string{"--context", "k3d-mycluster", "--namespace", "payments", "--action", "delete", "--target", "pod/api-1"}

func TestGrantFromUIWrongConfirmation(t *testing.T) {
	home, tok := uiHome(t)
	for _, typed := range []string{"", "k3d", "K3D-MYCLUSTER", "k3d-mycluster "} {
		code, _, errs := runUI(home, tok, append(podArgs, "--confirm", typed)...)
		if code == 0 || !strings.Contains(errs, "did not match") {
			t.Fatalf("typed %q: code %d, %s", typed, code, errs)
		}
	}
	if gs, _ := grant.NewStore(home).List(); len(gs) != 0 {
		t.Fatal("grant issued on a wrong confirmation")
	}
}

func TestGrantFromUIRightConfirmation(t *testing.T) {
	home, tok := uiHome(t)
	code, out, errs := runUI(home, tok, append(podArgs, "--confirm", "k3d-mycluster")...)
	if code != 0 {
		t.Fatalf("code %d: %s", code, errs)
	}
	var g map[string]any
	if err := json.Unmarshal([]byte(out), &g); err != nil || g["target"] != "pod/api-1" || g["tier"] != "dev" {
		t.Fatalf("bad output %q (%v)", out, err)
	}
	s := grant.NewStore(home)
	if _, err := s.Consume("k3d-mycluster", "payments", "delete", "pod/api-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Consume("k3d-mycluster", "payments", "delete", "pod/api-1"); err == nil {
		t.Fatal("grant reused")
	}
	// the token rotated: the same value can't issue a second grant
	if code, _, _ := runUI(home, tok, append(podArgs, "--confirm", "k3d-mycluster")...); code == 0 {
		t.Fatal("a used UI token issued another grant")
	}
	b, _ := os.ReadFile(home + "/audit.log")
	if !strings.Contains(string(b), `"source":"ui"`) || !strings.Contains(string(b), `"outcome":"granted"`) {
		t.Fatalf("audit log missing the grant: %s", b)
	}
}

func TestGrantFromUIRefusals(t *testing.T) {
	home, tok := uiHome(t)
	cases := []struct {
		name  string
		token string
		args  []string
	}{
		{"no token", "", append(podArgs, "--confirm", "k3d-mycluster")},
		{"wrong token", strings.Repeat("0", 64), append(podArgs, "--confirm", "k3d-mycluster")},
		{"scale a pod", tok, []string{"--context", "k3d-mycluster", "--namespace", "payments", "--action", "scale-zero", "--target", "pod/api-1", "--confirm", "k3d-mycluster"}},
		{"drain", tok, []string{"--context", "k3d-mycluster", "--action", "drain", "--target", "node/n1", "--confirm", "k3d-mycluster"}},
		{"secret", tok, []string{"--context", "k3d-mycluster", "--namespace", "payments", "--action", "delete", "--target", "secret/db", "--confirm", "k3d-mycluster"}},
		{"wildcard", tok, []string{"--context", "k3d-mycluster", "--namespace", "payments", "--action", "delete", "--target", "pod/*", "--confirm", "k3d-mycluster"}},
	}
	for _, c := range cases {
		if code, _, _ := runUI(home, c.token, c.args...); code == 0 {
			t.Fatalf("%s: granted", c.name)
		}
	}
	t.Setenv("K8SH_AGENT", "1")
	if code, _, errs := runUI(home, tok, append(podArgs, "--confirm", "k3d-mycluster")...); code == 0 || !strings.Contains(errs, "MCP environment") {
		t.Fatalf("granted from the agent's MCP environment: %s", errs)
	}
	if gs, _ := grant.NewStore(home).List(); len(gs) != 0 {
		t.Fatal("a refused request left a grant")
	}
}
