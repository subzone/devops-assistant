package incident

import (
	"strings"
	"testing"
	"time"
)

func TestLifecycle(t *testing.T) {
	now := time.Date(2026, 11, 27, 9, 0, 0, 0, time.UTC)
	s := Store{Home: t.TempDir(), Now: func() time.Time { now = now.Add(time.Minute); return now }}

	in, err := s.Open("api-2 crash looping", "sev2", "k3d-mycluster", "payments", []string{"pod/api-2", " ", "deployment/api"}, "OOMKilled, token=abc123secret", "pane")
	if err != nil || in.ID != "INC-1" || in.Status != "open" || len(in.Objects) != 2 || in.Timeline[0].By != "pane" {
		t.Fatalf("open: %+v %v", in, err)
	}
	if strings.Contains(in.Timeline[0].Text, "abc123secret") {
		t.Fatal("note not redacted")
	}
	in2, _ := s.Open("second", "", "", "", nil, "", "someone")
	if in2.ID != "INC-2" || in2.Severity != "sev3" || in2.Timeline[0].By != "claude" {
		t.Fatalf("defaults: %+v", in2)
	}

	if _, err := s.Note("INC-1", "raised the memory limit in PR #12", "claude", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetStatus("INC-1", "mitigated", "", "pane"); err != nil {
		t.Fatal(err)
	}
	got, err := s.SetStatus("INC-1", "resolved", "stable for an hour", "pane")
	if err != nil || got.ResolvedAt == nil || len(got.Timeline) != 4 || !strings.Contains(got.Timeline[3].Text, "mitigated → resolved: stable for an hour") {
		t.Fatalf("resolve: %+v %v", got, err)
	}

	active, _ := s.List("active")
	if len(active) != 1 || active[0].ID != "INC-2" {
		t.Fatalf("active: %+v", active)
	}
	all, _ := s.List("")
	if len(all) != 2 || all[0].ID != "INC-2" {
		t.Fatalf("all newest first: %+v", all)
	}
}

func TestRefusals(t *testing.T) {
	s := Store{Home: t.TempDir()}
	if _, err := s.Open("  ", "sev3", "", "", nil, "", ""); err == nil {
		t.Error("empty title accepted")
	}
	if _, err := s.Open("x", "sev9", "", "", nil, "", ""); err == nil {
		t.Error("bad severity accepted")
	}
	in, _ := s.Open("x", "sev4", "", "", nil, "", "")
	if _, err := s.SetStatus(in.ID, "closed", "", ""); err == nil {
		t.Error("bad status accepted")
	}
	if _, err := s.Note("INC-99", "hi", "", ""); err == nil {
		t.Error("unknown incident accepted")
	}
	if _, err := s.Note(in.ID, "   ", "", ""); err == nil {
		t.Error("empty note accepted")
	}
}
