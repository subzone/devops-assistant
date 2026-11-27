// Package incident keeps incidents in ~/.k8sh/incidents.json: a title,
// severity, status, the cluster objects involved and a timeline of notes,
// status changes and monitoring alerts. Local state only; nothing here
// touches a cluster. Texts are redacted before they are stored.
package incident

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/subzone/devops-assistant/internal/redact"
)

type Entry struct {
	At   time.Time `json:"at"`
	By   string    `json:"by"`   // claude | pane | monitor
	Kind string    `json:"kind"` // opened | note | status | alert
	Text string    `json:"text"`
}

type Incident struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Severity   string     `json:"severity"` // sev1 (worst) .. sev4
	Status     string     `json:"status"`   // open | mitigated | resolved
	Context    string     `json:"context,omitempty"`
	Namespace  string     `json:"namespace,omitempty"`
	Objects    []string   `json:"objects,omitempty"`
	OpenedAt   time.Time  `json:"openedAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	ResolvedAt *time.Time `json:"resolvedAt,omitempty"`
	Timeline   []Entry    `json:"timeline"`
}

var (
	Severities = []string{"sev1", "sev2", "sev3", "sev4"}
	Statuses   = []string{"open", "mitigated", "resolved"}
	Sources    = []string{"claude", "pane", "monitor"}
)

const (
	maxIncidents = 300
	maxTimeline  = 500
	maxText      = 2000
)

type Store struct {
	Home string
	Now  func() time.Time
}

var mu sync.Mutex

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s Store) path() string { return filepath.Join(s.Home, "incidents.json") }

func (s Store) load() ([]Incident, error) {
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var is []Incident
	return is, json.Unmarshal(b, &is)
}

func (s Store) save(is []Incident) error {
	if err := os.MkdirAll(s.Home, 0o700); err != nil {
		return err
	}
	if len(is) > maxIncidents {
		// drop the oldest resolved ones first
		sort.SliceStable(is, func(i, j int) bool {
			ri, rj := is[i].Status == "resolved", is[j].Status == "resolved"
			if ri != rj {
				return !ri
			}
			return is[i].UpdatedAt.After(is[j].UpdatedAt)
		})
		is = is[:maxIncidents]
	}
	b, err := json.Marshal(is)
	if err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}

func clean(t string, max int) string {
	t = strings.TrimSpace(redact.Text(t))
	if len(t) > max {
		t = t[:max] + "…"
	}
	return t
}

func oneOf(v string, set []string, field string) error {
	for _, s := range set {
		if v == s {
			return nil
		}
	}
	return fmt.Errorf("%s must be one of %s", field, strings.Join(set, ", "))
}

func source(by string) string {
	if oneOf(by, Sources, "by") != nil {
		return "claude"
	}
	return by
}

// List: newest first; status filters ("" = all, "active" = open or mitigated).
func (s Store) List(status string) ([]Incident, error) {
	mu.Lock()
	defer mu.Unlock()
	is, err := s.load()
	if err != nil {
		return nil, err
	}
	out := []Incident{}
	for _, in := range is {
		if status == "" || in.Status == status || (status == "active" && in.Status != "resolved") {
			out = append(out, in)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].OpenedAt.After(out[j].OpenedAt) })
	return out, nil
}

// Open starts an incident; the note, if any, is its first timeline entry.
func (s Store) Open(title, severity, context, namespace string, objects []string, note, by string) (Incident, error) {
	title = clean(title, 200)
	if title == "" {
		return Incident{}, errors.New("an incident needs a title")
	}
	if severity == "" {
		severity = "sev3"
	}
	if err := oneOf(severity, Severities, "severity"); err != nil {
		return Incident{}, err
	}
	mu.Lock()
	defer mu.Unlock()
	is, err := s.load()
	if err != nil {
		return Incident{}, err
	}
	n := 0
	for _, in := range is {
		var k int
		if _, err := fmt.Sscanf(in.ID, "INC-%d", &k); err == nil && k > n {
			n = k
		}
	}
	now := s.now()
	in := Incident{ID: fmt.Sprintf("INC-%d", n+1), Title: title, Severity: severity, Status: "open", Context: clean(context, 200), Namespace: clean(namespace, 200), OpenedAt: now, UpdatedAt: now}
	for _, o := range objects {
		if o = clean(o, 200); o != "" && len(in.Objects) < 20 {
			in.Objects = append(in.Objects, o)
		}
	}
	text := "opened: " + title
	if note = clean(note, maxText); note != "" {
		text += " — " + note
	}
	in.Timeline = []Entry{{At: now, By: source(by), Kind: "opened", Text: text}}
	is = append(is, in)
	return in, s.save(is)
}

func (s Store) change(id string, fn func(*Incident, time.Time) error) (Incident, error) {
	mu.Lock()
	defer mu.Unlock()
	is, err := s.load()
	if err != nil {
		return Incident{}, err
	}
	for i := range is {
		if is[i].ID == id {
			now := s.now()
			if err := fn(&is[i], now); err != nil {
				return Incident{}, err
			}
			is[i].UpdatedAt = now
			if len(is[i].Timeline) > maxTimeline {
				is[i].Timeline = is[i].Timeline[len(is[i].Timeline)-maxTimeline:]
			}
			return is[i], s.save(is)
		}
	}
	return Incident{}, fmt.Errorf("no incident %q", id)
}

// Note adds a timeline entry; kind is note (default) or alert.
func (s Store) Note(id, text, by, kind string) (Incident, error) {
	text = clean(text, maxText)
	if text == "" {
		return Incident{}, errors.New("a note needs text")
	}
	if kind != "alert" {
		kind = "note"
	}
	return s.change(id, func(in *Incident, now time.Time) error {
		in.Timeline = append(in.Timeline, Entry{At: now, By: source(by), Kind: kind, Text: text})
		return nil
	})
}

// SetStatus moves an incident to open, mitigated or resolved, with an
// optional note on the timeline.
func (s Store) SetStatus(id, status, note, by string) (Incident, error) {
	if err := oneOf(status, Statuses, "status"); err != nil {
		return Incident{}, err
	}
	return s.change(id, func(in *Incident, now time.Time) error {
		text := in.Status + " → " + status
		if n := clean(note, maxText); n != "" {
			text += ": " + n
		}
		in.Status = status
		if status == "resolved" {
			t := now
			in.ResolvedAt = &t
		} else {
			in.ResolvedAt = nil
		}
		in.Timeline = append(in.Timeline, Entry{At: now, By: source(by), Kind: "status", Text: text})
		return nil
	})
}
