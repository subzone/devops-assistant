// Package settings merges k8s-handler recommendations into a Claude Code
// settings.json. It only ever ADDS deny rules and a status line; it never
// removes or loosens anything, and it keeps a .bak of the original.
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
)

var DenyRules = []string{
	"Read(~/.kube/**)",
	"Read(~/.aws/**)",
	"Read(~/.azure/**)",
	"Read(~/.config/gcloud/**)",
	"Read(~/.docker/config.json)",
	"Read(~/.ssh/**)",
	"Read(~/.k8sh/**)",
	"Edit(~/.k8sh/**)",
	"Write(~/.k8sh/**)",
	"Read(./**/.env)",
	"Read(./**/.env.*)",
	"Read(./**/*.pem)",
	"Read(./**/*.key)",
	"Bash(kubectl delete:*)",
	"Bash(kubectl apply:*)",
	"Bash(kubectl get secret:*)",
	"Bash(helm uninstall:*)",
	"Bash(helm upgrade:*)",
	"Bash(helm install:*)",
	"Bash(argocd app delete:*)",
	"Bash(git push --force:*)",
	"Bash(k8sh unlock:*)",
}

type Result struct {
	Path              string   `json:"path"`
	Backup            string   `json:"backup,omitempty"`
	AddedDeny         []string `json:"addedDeny"`
	StatusLine        string   `json:"statusLine"` // set | kept-existing | skipped
	ExistingStatusCmd string   `json:"existingStatusLine,omitempty"`
	DryRun            bool     `json:"dryRun"`
}

func DefaultPath() (string, error) {
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".claude", "settings.json"), nil
}

// Apply merges deny rules and (optionally) the status line into path.
// An existing statusLine is never replaced unless force is set.
func Apply(path, statusCmd string, force, dryRun bool) (*Result, error) {
	res := &Result{Path: path, DryRun: dryRun, AddedDeny: []string{}}
	doc := map[string]any{}
	orig, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		orig = nil
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(orig, &doc); err != nil {
			return nil, fmt.Errorf("%s is not valid JSON, not touching it: %w", path, err)
		}
	}

	perms, _ := doc["permissions"].(map[string]any)
	if perms == nil {
		perms = map[string]any{}
	}
	have := map[string]bool{}
	var deny []any
	if d, ok := perms["deny"].([]any); ok {
		deny = d
		for _, r := range d {
			if s, ok := r.(string); ok {
				have[s] = true
			}
		}
	}
	for _, r := range DenyRules {
		if !have[r] {
			deny = append(deny, r)
			res.AddedDeny = append(res.AddedDeny, r)
		}
	}
	sort.Strings(res.AddedDeny)
	perms["deny"] = deny
	doc["permissions"] = perms

	res.StatusLine = "skipped"
	if statusCmd != "" {
		if sl, ok := doc["statusLine"].(map[string]any); ok && !force {
			res.StatusLine = "kept-existing"
			res.ExistingStatusCmd, _ = sl["command"].(string)
		} else {
			doc["statusLine"] = map[string]any{"type": "command", "command": statusCmd}
			res.StatusLine = "set"
		}
	}

	if dryRun || (len(res.AddedDeny) == 0 && res.StatusLine != "set") {
		return res, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if orig != nil {
		res.Backup = path + ".bak"
		if err := os.WriteFile(res.Backup, orig, 0o600); err != nil {
			return nil, err
		}
	}
	b, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	tmp := path + ".k8sh.tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return nil, err
	}
	return res, os.Rename(tmp, path)
}
