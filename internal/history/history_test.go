package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOpenedStillResolvedBack(t *testing.T) {
	home := t.TempDir()
	t0 := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	crash := Signal{Namespace: "payments", Object: "pod/api-2/app", Signal: "CrashLoopBackOff", Severity: 9, Detail: "back-off password=hunter2"}
	oom := Signal{Namespace: "payments", Object: "pod/api-2/app", Signal: "OOMKilled", Severity: 9}

	opened, resolved, err := Update(home, "dev", "", []Signal{crash, oom}, t0)
	if err != nil || len(opened) != 2 || len(resolved) != 0 {
		t.Fatalf("first: %v %v %v", opened, resolved, err)
	}
	// still there: nothing new
	opened, resolved, _ = Update(home, "dev", "", []Signal{crash, oom}, t0.Add(time.Minute))
	if len(opened) != 0 || len(resolved) != 0 {
		t.Fatalf("second: %v %v", opened, resolved)
	}
	// OOM gone
	opened, resolved, _ = Update(home, "dev", "", []Signal{crash}, t0.Add(2*time.Minute))
	if len(opened) != 0 || len(resolved) != 1 || resolved[0].Signal != "OOMKilled" {
		t.Fatalf("third: %v %v", opened, resolved)
	}
	// back again: reopened, counted
	opened, _, _ = Update(home, "dev", "", []Signal{crash, oom}, t0.Add(3*time.Minute))
	if len(opened) != 1 || opened[0].Times != 2 {
		t.Fatalf("fourth: %+v", opened)
	}

	rs, err := List(home, "dev", "", t0.Add(-time.Hour), false)
	if err != nil || len(rs) != 2 {
		t.Fatalf("list: %v %v", rs, err)
	}
	for _, r := range rs {
		if !r.FirstSeen.Equal(t0) || !r.Open() {
			t.Fatalf("record: %+v", r)
		}
		if strings.Contains(r.Detail, "hunter2") {
			t.Fatal("detail not redacted")
		}
	}
	if st, _ := os.Stat(filepath.Join(home, "rca-history.json")); st.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", st.Mode().Perm())
	}
}

func TestNamespaceScopeOnlyResolvesItsOwn(t *testing.T) {
	home := t.TempDir()
	t0 := time.Now().UTC()
	a := Signal{Namespace: "a", Object: "pod/x", Signal: "Pending", Severity: 8}
	b := Signal{Namespace: "b", Object: "pod/y", Signal: "Pending", Severity: 8}
	Update(home, "dev", "", []Signal{a, b}, t0)
	// a collection of namespace a alone, empty: only a's problem resolves
	_, resolved, _ := Update(home, "dev", "a", nil, t0.Add(time.Minute))
	if len(resolved) != 1 || resolved[0].Namespace != "a" {
		t.Fatalf("resolved %v", resolved)
	}
	// another context is untouched
	_, resolved, _ = Update(home, "prod", "", nil, t0.Add(2*time.Minute))
	if len(resolved) != 0 {
		t.Fatalf("prod resolved %v", resolved)
	}
	open, _ := List(home, "dev", "", t0.Add(-time.Hour), true)
	if len(open) != 1 || open[0].Namespace != "b" {
		t.Fatalf("open %v", open)
	}
}
