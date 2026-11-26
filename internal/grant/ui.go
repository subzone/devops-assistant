package grant

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// The UI token lets the k8s pane (a Claude Code mod running in the host
// process) issue a grant after the user typed the context name into the pane.
//
// The token lives in ~/.k8sh/ui.token (0600). The mod reads it with the
// host's own file API, which no agent tool goes through; the agent's Read,
// Bash, Grep and Glob are blocked from ~/.k8sh by the PreToolUse hook, and
// `k8sh grant-from-ui` itself is blocked in Bash. The token is rotated after
// every grant, so a value seen once is useless afterwards.
//
// This is defence in depth, not isolation: a process running as the same OS
// user outside Claude's tools can read the file. See SECURITY.md.

const uiTokenFile = "ui.token"

// UITokenPath returns where the UI token is kept.
func UITokenPath(home string) string { return filepath.Join(home, uiTokenFile) }

// EnsureUIToken creates the UI token if it is missing and returns its path.
// It never prints or returns the token itself.
func EnsureUIToken(home string) (string, error) {
	p := UITokenPath(home)
	if b, err := os.ReadFile(p); err == nil && len(strings.TrimSpace(string(b))) == 64 {
		return p, nil
	}
	return p, RotateUIToken(home)
}

// RotateUIToken replaces the UI token with a fresh random one.
func RotateUIToken(home string) error {
	if err := os.MkdirAll(home, 0o700); err != nil {
		return err
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return err
	}
	p := UITokenPath(home)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, []byte(hex.EncodeToString(b)+"\n"), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

// CheckUIToken compares a presented token with the stored one in constant time.
func CheckUIToken(home, presented string) error {
	b, err := os.ReadFile(UITokenPath(home))
	if err != nil {
		return errors.New("no UI token: open the k8s pane (/k8s) and retry")
	}
	want := strings.TrimSpace(string(b))
	got := strings.TrimSpace(presented)
	if len(want) != 64 || subtle.ConstantTimeCompare([]byte(want), []byte(got)) != 1 {
		return errors.New("UI token mismatch: grants from the pane must come from the k8s pane itself")
	}
	return nil
}

// UIActionAllowed is the narrow set of actions the pane can unlock:
// delete for pods and daemonsets; delete or scale-zero for deployments and
// statefulsets (a daemonset has no replica count to scale).
func UIActionAllowed(action, target string) error {
	kind, name, ok := strings.Cut(target, "/")
	if !ok || name == "" || strings.Contains(name, "/") {
		return errors.New("target must be kind/name")
	}
	switch kind {
	case "pod", "daemonset":
		if action == "delete" {
			return nil
		}
	case "deployment", "statefulset":
		if action == "delete" || action == "scale-zero" {
			return nil
		}
	default:
		return errors.New("the pane can only unlock pods and workloads (deployment, statefulset, daemonset)")
	}
	return errors.New("action " + action + " is not available from the pane for " + kind)
}
