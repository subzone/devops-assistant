// Package history keeps RCA findings over time in ~/.k8sh/rca-history.json:
// when each problem was first and last seen, how often, and when it went
// away. Every rca_collect updates it, so it answers "since when?" and "has
// this happened before?". Texts are redacted before they are stored.
package history

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/subzone/devops-assistant/internal/redact"
)

// Signal is one finding as RCA reports it.
type Signal struct {
	Namespace string
	Object    string
	Signal    string
	Severity  int
	Detail    string
}

// Record is a problem across collections.
type Record struct {
	Context    string     `json:"context"`
	Namespace  string     `json:"namespace,omitempty"`
	Object     string     `json:"object"`
	Signal     string     `json:"signal"`
	Severity   int        `json:"severity"`
	Detail     string     `json:"detail,omitempty"`
	FirstSeen  time.Time  `json:"firstSeen"`
	LastSeen   time.Time  `json:"lastSeen"`
	Seen       int        `json:"seen"`
	Times      int        `json:"times"` // separate occurrences: 1 + times it came back after resolving
	ResolvedAt *time.Time `json:"resolvedAt,omitempty"`
}

func (r Record) key() string { return r.Context + "|" + r.Namespace + "|" + r.Object + "|" + r.Signal }

// Open: not resolved.
func (r Record) Open() bool { return r.ResolvedAt == nil }

const (
	maxRecords = 2000
	keepFor    = 30 * 24 * time.Hour
)

var mu sync.Mutex

func path(home string) string { return filepath.Join(home, "rca-history.json") }

func load(home string) ([]Record, error) {
	b, err := os.ReadFile(path(home))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var rs []Record
	if err := json.Unmarshal(b, &rs); err != nil {
		return nil, err
	}
	return rs, nil
}

func save(home string, rs []Record) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(rs)
	if err != nil {
		return err
	}
	tmp := path(home) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path(home))
}

// Update records one collection for a context and namespace ("" = all):
// what it found is open (new, still there or back again), and what was open
// in that scope and is not found any more is resolved. It returns the
// problems that opened (new or back) and the ones that resolved.
func Update(home, context, namespace string, found []Signal, now time.Time) (opened, resolved []Record, err error) {
	mu.Lock()
	defer mu.Unlock()
	rs, err := load(home)
	if err != nil {
		return nil, nil, err
	}
	idx := map[string]int{}
	for i, r := range rs {
		idx[r.key()] = i
	}
	seen := map[string]bool{}
	for _, f := range found {
		r := Record{Context: context, Namespace: f.Namespace, Object: f.Object, Signal: f.Signal}
		k := r.key()
		if seen[k] {
			continue
		}
		seen[k] = true
		if i, ok := idx[k]; ok {
			cur := &rs[i]
			if !cur.Open() {
				cur.ResolvedAt = nil
				cur.Times++
				opened = append(opened, *cur)
			}
			cur.LastSeen, cur.Seen = now, cur.Seen+1
			cur.Severity, cur.Detail = f.Severity, redact.Text(f.Detail)
			continue
		}
		r.Severity, r.Detail = f.Severity, redact.Text(f.Detail)
		r.FirstSeen, r.LastSeen, r.Seen, r.Times = now, now, 1, 1
		rs = append(rs, r)
		idx[k] = len(rs) - 1
		opened = append(opened, r)
	}
	for i := range rs {
		r := &rs[i]
		if r.Context != context || !r.Open() || seen[r.key()] {
			continue
		}
		if namespace != "" && r.Namespace != namespace {
			continue
		}
		t := now
		r.ResolvedAt = &t
		resolved = append(resolved, *r)
	}
	// keep: open ones, and resolved ones younger than 30 days, newest first past the cap
	kept := rs[:0]
	for _, r := range rs {
		if r.Open() || now.Sub(*r.ResolvedAt) < keepFor {
			kept = append(kept, r)
		}
	}
	if len(kept) > maxRecords {
		sort.SliceStable(kept, func(i, j int) bool { return kept[i].LastSeen.After(kept[j].LastSeen) })
		kept = kept[:maxRecords]
	}
	return opened, resolved, save(home, kept)
}

// List returns a context's records ("" = every context) seen since, open
// ones first (most severe first), then resolved ones (latest first).
func List(home, context, namespace string, since time.Time, openOnly bool) ([]Record, error) {
	mu.Lock()
	defer mu.Unlock()
	rs, err := load(home)
	if err != nil {
		return nil, err
	}
	out := []Record{}
	for _, r := range rs {
		if (context != "" && r.Context != context) || (namespace != "" && r.Namespace != namespace) {
			continue
		}
		if r.LastSeen.Before(since) || (openOnly && !r.Open()) {
			continue
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Open() != b.Open() {
			return a.Open()
		}
		if a.Open() {
			if a.Severity != b.Severity {
				return a.Severity > b.Severity
			}
			return a.FirstSeen.Before(b.FirstSeen)
		}
		return a.ResolvedAt.After(*b.ResolvedAt)
	})
	return out, nil
}
