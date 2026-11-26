// Package grant implements the destructive-action lock.
//
// Default state is locked. A grant unlocks exactly one action on one target
// in one context, for at most 15 minutes, and is consumed on use. Grants are
// only issued from an interactive terminal the user controls: the confirm
// prompt is read from /dev/tty, and issuing is refused inside an agent
// session (CLAUDECODE set) or without a controlling terminal.
//
// Threat model: see SECURITY.md. Grants are HMAC-signed so a stray or
// hand-edited file is rejected; the PreToolUse hook blocks agent access to
// ~/.k8sh. Same-OS-user isolation is a known limit; run the k8sh daemon as a
// separate user for a hard boundary (roadmap).
package grant

import (
	"bufio"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Actions that require a grant.
var Actions = map[string]string{
	"delete":              "delete a resource",
	"scale-zero":          "scale a workload to 0",
	"drain":               "drain a node",
	"cordon":              "cordon a node",
	"sync-prune":          "Argo CD sync with prune/force/replace",
	"app-delete":          "delete an Argo CD application",
	"helm-uninstall":      "helm uninstall",
	"rollback":            "manual rollback (helm/argo/rollouts)",
	"chaos-run":           "run a chaos experiment",
	"dr-restore":          "restore over existing resources",
	"upgrade":             "cluster or node-pool upgrade",
	"ansible-destructive": "ansible play with destructive tasks",
	"force-push":          "git force-push / branch delete",
	"secret-rotate":       "rotate or revoke a secret",
}

type Grant struct {
	ID        string    `json:"id"`
	Context   string    `json:"context"`
	Namespace string    `json:"namespace"`
	Action    string    `json:"action"`
	Target    string    `json:"target"`
	CreatedAt time.Time `json:"createdAt"`
	ExpiresAt time.Time `json:"expiresAt"`
	MAC       string    `json:"mac"`
}

func (g Grant) payload() string {
	return strings.Join([]string{g.ID, g.Context, g.Namespace, g.Action, g.Target,
		g.CreatedAt.UTC().Format(time.RFC3339Nano), g.ExpiresAt.UTC().Format(time.RFC3339Nano)}, "\x1f")
}

type Store struct {
	Dir string
	Now func() time.Time
}

func NewStore(home string) *Store {
	return &Store{Dir: home, Now: time.Now}
}

func (s *Store) grantsDir() string { return filepath.Join(s.Dir, "grants") }

func (s *Store) key() ([]byte, error) {
	p := filepath.Join(s.Dir, "grant.key")
	k, err := os.ReadFile(p)
	if err == nil && len(k) == 32 {
		return k, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	k = make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		return nil, err
	}
	return k, os.WriteFile(p, k, 0o600)
}

func (s *Store) sign(g *Grant) error {
	k, err := s.key()
	if err != nil {
		return err
	}
	m := hmac.New(sha256.New, k)
	m.Write([]byte(g.payload()))
	g.MAC = hex.EncodeToString(m.Sum(nil))
	return nil
}

func (s *Store) verify(g Grant) bool {
	k, err := s.key()
	if err != nil {
		return false
	}
	m := hmac.New(sha256.New, k)
	m.Write([]byte(g.payload()))
	want, err := hex.DecodeString(g.MAC)
	return err == nil && hmac.Equal(m.Sum(nil), want)
}

// Terminal abstracts the interactive confirmation channel.
type Terminal interface {
	io.ReadWriter
}

// OpenTTY opens the controlling terminal. It fails inside agent sessions.
func OpenTTY() (Terminal, func(), error) {
	if os.Getenv("CLAUDECODE") != "" || os.Getenv("K8SH_AGENT") != "" {
		return nil, nil, errors.New("refusing to issue a grant inside an agent session; run this in your own terminal")
	}
	f, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("no controlling terminal: unlock must be run interactively (%w)", err)
	}
	return f, func() { f.Close() }, nil
}

type Request struct {
	Context, Namespace, Action, Target string
	TTL                                time.Duration
	Tier                               string
}

func (req *Request) normalize(maxTTL time.Duration) error {
	if _, ok := Actions[req.Action]; !ok {
		return fmt.Errorf("unknown action %q", req.Action)
	}
	if req.Context == "" || req.Target == "" {
		return errors.New("context and target are required")
	}
	if strings.ContainsAny(req.Target, "*?") {
		return errors.New("wildcard targets are not allowed")
	}
	if req.TTL <= 0 {
		req.TTL = 10 * time.Minute
	}
	if req.TTL > maxTTL {
		req.TTL = maxTTL
	}
	return nil
}

// Issue asks the user to type the context name on the terminal, then writes
// a signed single-use grant.
func (s *Store) Issue(req Request, tty Terminal, maxTTL time.Duration) (*Grant, error) {
	if err := req.normalize(maxTTL); err != nil {
		return nil, err
	}
	fmt.Fprintf(tty, "\n  DESTRUCTIVE ACTION GRANT\n  context:   %s (tier: %s)\n  namespace: %s\n  action:    %s — %s\n  target:    %s\n  valid for: %s, single use\n\n  Type the context name to confirm: ",
		req.Context, req.Tier, orDash(req.Namespace), req.Action, Actions[req.Action], req.Target, req.TTL)
	line, err := bufio.NewReader(tty).ReadString('\n')
	if err != nil && line == "" {
		return nil, errors.New("no confirmation received")
	}
	return s.IssueConfirmed(req, strings.TrimSpace(line), maxTTL)
}

// IssueConfirmed writes a signed single-use grant when typed equals the
// context name exactly. The caller is responsible for having collected typed
// from the user (the terminal prompt in Issue, or the k8s pane's Input).
func (s *Store) IssueConfirmed(req Request, typed string, maxTTL time.Duration) (*Grant, error) {
	if err := req.normalize(maxTTL); err != nil {
		return nil, err
	}
	if typed != req.Context {
		return nil, errors.New("confirmation did not match; nothing unlocked")
	}
	idb := make([]byte, 8)
	rand.Read(idb)
	now := s.Now().UTC()
	g := &Grant{ID: hex.EncodeToString(idb), Context: req.Context, Namespace: req.Namespace,
		Action: req.Action, Target: req.Target, CreatedAt: now, ExpiresAt: now.Add(req.TTL)}
	if err := s.sign(g); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(s.grantsDir(), 0o700); err != nil {
		return nil, err
	}
	b, _ := json.Marshal(g)
	if err := os.WriteFile(filepath.Join(s.grantsDir(), g.ID+".json"), b, 0o600); err != nil {
		return nil, err
	}
	return g, nil
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// List returns valid, unexpired grants. Invalid or expired files are removed.
func (s *Store) List() ([]Grant, error) {
	ents, err := os.ReadDir(s.grantsDir())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Grant
	now := s.Now()
	for _, e := range ents {
		p := filepath.Join(s.grantsDir(), e.Name())
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var g Grant
		if json.Unmarshal(b, &g) != nil || !s.verify(g) || now.After(g.ExpiresAt) || e.Name() != g.ID+".json" {
			os.Remove(p)
			continue
		}
		out = append(out, g)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ExpiresAt.Before(out[j].ExpiresAt) })
	return out, nil
}

// ErrLocked is returned when no matching grant exists.
var ErrLocked = errors.New("LOCKED: no user grant for this action")

// Consume finds an exact-match grant and deletes it atomically.
func (s *Store) Consume(ctx, ns, action, target string) (*Grant, error) {
	gs, err := s.List()
	if err != nil {
		return nil, err
	}
	for _, g := range gs {
		if g.Context == ctx && g.Namespace == ns && g.Action == action && g.Target == target {
			p := filepath.Join(s.grantsDir(), g.ID+".json")
			used := p + ".used"
			if err := os.Rename(p, used); err != nil {
				continue // someone else consumed it
			}
			os.Remove(used)
			g := g
			return &g, nil
		}
	}
	return nil, fmt.Errorf("%w. Ask the user to run in their own terminal:\n  k8sh unlock --context %s --namespace %s --action %s --target %s",
		ErrLocked, ctx, orDash(ns), action, target)
}

// RevokeAll removes every grant.
func (s *Store) RevokeAll() (int, error) {
	ents, err := os.ReadDir(s.grantsDir())
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	n := 0
	for _, e := range ents {
		if os.Remove(filepath.Join(s.grantsDir(), e.Name())) == nil {
			n++
		}
	}
	return n, err
}
