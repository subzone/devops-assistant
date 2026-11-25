package grant

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeTTY struct {
	in  *strings.Reader
	out bytes.Buffer
}

func (f *fakeTTY) Read(p []byte) (int, error)  { return f.in.Read(p) }
func (f *fakeTTY) Write(p []byte) (int, error) { return f.out.Write(p) }

func tty(s string) *fakeTTY { return &fakeTTY{in: strings.NewReader(s)} }

func req() Request {
	return Request{Context: "eks-prod", Namespace: "pay", Action: "delete", Target: "pod/api-1", TTL: 5 * time.Minute}
}

func TestIssueAndConsumeOnce(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Issue(req(), tty("eks-prod\n"), 15*time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); !errors.Is(err, ErrLocked) {
		t.Fatal("grant reused")
	}
}

func TestWrongConfirmation(t *testing.T) {
	s := NewStore(t.TempDir())
	if _, err := s.Issue(req(), tty("yes\n"), 15*time.Minute); err == nil {
		t.Fatal("issued with wrong confirmation")
	}
}

func TestScopeMismatch(t *testing.T) {
	s := NewStore(t.TempDir())
	s.Issue(req(), tty("eks-prod\n"), 15*time.Minute)
	for _, c := range [][4]string{
		{"eks-dev", "pay", "delete", "pod/api-1"},
		{"eks-prod", "other", "delete", "pod/api-1"},
		{"eks-prod", "pay", "drain", "pod/api-1"},
		{"eks-prod", "pay", "delete", "pod/api-2"},
	} {
		if _, err := s.Consume(c[0], c[1], c[2], c[3]); err == nil {
			t.Fatalf("mismatched scope accepted: %v", c)
		}
	}
}

func TestExpiry(t *testing.T) {
	s := NewStore(t.TempDir())
	s.Issue(req(), tty("eks-prod\n"), 15*time.Minute)
	s.Now = func() time.Time { return time.Now().Add(6 * time.Minute) }
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); err == nil {
		t.Fatal("expired grant accepted")
	}
}

func TestTTLCapped(t *testing.T) {
	s := NewStore(t.TempDir())
	r := req()
	r.TTL = 5 * time.Hour
	g, err := s.Issue(r, tty("eks-prod\n"), 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if g.ExpiresAt.Sub(g.CreatedAt) > 15*time.Minute {
		t.Fatal("ttl not capped")
	}
}

func TestForgedGrantRejected(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	s.key()
	os.MkdirAll(filepath.Join(dir, "grants"), 0o700)
	g := Grant{ID: "abcd", Context: "eks-prod", Namespace: "pay", Action: "delete", Target: "pod/api-1",
		CreatedAt: time.Now(), ExpiresAt: time.Now().Add(time.Minute), MAC: "00"}
	b, _ := json.Marshal(g)
	os.WriteFile(filepath.Join(dir, "grants", "abcd.json"), b, 0o600)
	if _, err := s.Consume("eks-prod", "pay", "delete", "pod/api-1"); err == nil {
		t.Fatal("forged grant accepted")
	}
}

func TestWildcardRefused(t *testing.T) {
	s := NewStore(t.TempDir())
	r := req()
	r.Target = "pod/*"
	if _, err := s.Issue(r, tty("eks-prod\n"), 15*time.Minute); err == nil {
		t.Fatal("wildcard accepted")
	}
}

func TestAgentSessionRefused(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	if _, _, err := OpenTTY(); err == nil {
		t.Fatal("tty opened inside agent session")
	}
}
