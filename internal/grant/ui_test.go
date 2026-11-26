package grant

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func TestIssueConfirmedExactMatch(t *testing.T) {
	s := NewStore(t.TempDir())
	for _, typed := range []string{"", "eks-pro", "EKS-PROD", " eks-prod", "eks-prod\n", "yes"} {
		if _, err := s.IssueConfirmed(req(), typed, 15*time.Minute); err == nil {
			t.Fatalf("issued with confirmation %q", typed)
		}
	}
	if gs, _ := s.List(); len(gs) != 0 {
		t.Fatal("a refused confirmation left a grant behind")
	}
	if _, err := s.IssueConfirmed(req(), "eks-prod", 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); !errors.Is(err, ErrLocked) {
		t.Fatal("grant reused")
	}
}

func TestIssueConfirmedKeepsRules(t *testing.T) {
	s := NewStore(t.TempDir())
	r := req()
	r.TTL = 5 * time.Hour
	g, err := s.IssueConfirmed(r, "eks-prod", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if g.ExpiresAt.Sub(g.CreatedAt) > 15*time.Minute {
		t.Fatal("ttl not capped")
	}
	r = req()
	r.Target = "pod/*"
	if _, err := s.IssueConfirmed(r, "eks-prod", 15*time.Minute); err == nil {
		t.Fatal("wildcard accepted")
	}
}

func TestUIToken(t *testing.T) {
	home := t.TempDir()
	if err := CheckUIToken(home, "x"); err == nil {
		t.Fatal("accepted with no token file")
	}
	p, err := EnsureUIToken(home)
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(p)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("token file mode %v, %v", st.Mode().Perm(), err)
	}
	b, _ := os.ReadFile(p)
	tok := strings.TrimSpace(string(b))
	if err := CheckUIToken(home, tok+"\n"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"", tok[:63], tok + "0", strings.ToUpper(tok)} {
		if CheckUIToken(home, bad) == nil {
			t.Fatalf("accepted bad token %q", bad)
		}
	}
	if p2, _ := EnsureUIToken(home); p2 != p {
		t.Fatal("path changed")
	}
	if b2, _ := os.ReadFile(p); string(b2) != string(b) {
		t.Fatal("EnsureUIToken replaced a valid token")
	}
	if err := RotateUIToken(home); err != nil {
		t.Fatal(err)
	}
	if CheckUIToken(home, tok) == nil {
		t.Fatal("old token still accepted after rotation")
	}
}

func TestUIActionAllowed(t *testing.T) {
	ok := [][2]string{
		{"delete", "pod/api-1"},
		{"delete", "deployment/api"},
		{"scale-zero", "deployment/api"},
		{"delete", "statefulset/db"},
		{"scale-zero", "statefulset/db"},
		{"delete", "daemonset/agent"},
	}
	for _, c := range ok {
		if err := UIActionAllowed(c[0], c[1]); err != nil {
			t.Fatalf("%v refused: %v", c, err)
		}
	}
	bad := [][2]string{
		{"scale-zero", "pod/api-1"},
		{"scale-zero", "daemonset/agent"},
		{"drain", "pod/api-1"},
		{"delete", "namespace/payments"},
		{"delete", "secret/db"},
		{"app-delete", "deployment/api"},
		{"delete", "pod"},
		{"delete", "pod/"},
		{"delete", "pod/a/b"},
	}
	for _, c := range bad {
		if UIActionAllowed(c[0], c[1]) == nil {
			t.Fatalf("%v allowed", c)
		}
	}
}
