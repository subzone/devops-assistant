// Package focus is the TUI -> Claude bridge: the TUI writes the selected
// object (redacted) and the k8sh MCP server reads it back for Claude.
package focus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/subzone/devops-assistant/internal/redact"
)

type Focus struct {
	Time      time.Time `json:"time"`
	Context   string    `json:"context"`
	Tier      string    `json:"tier"`
	View      string    `json:"view"`
	Namespace string    `json:"namespace,omitempty"`
	Kind      string    `json:"kind,omitempty"`
	Name      string    `json:"name,omitempty"`
	Status    string    `json:"status,omitempty"`
	Detail    string    `json:"detail,omitempty"`
}

func path(home string) string { return filepath.Join(home, "focus.json") }

func Write(home string, f Focus) error {
	f.Time = time.Now().UTC()
	f.Detail = redact.Text(f.Detail)
	if len(f.Detail) > 16000 {
		f.Detail = f.Detail[:16000]
	}
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	os.MkdirAll(home, 0o700)
	tmp := path(home) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path(home))
}

func Read(home string) (*Focus, error) {
	b, err := os.ReadFile(path(home))
	if err != nil {
		return nil, err
	}
	var f Focus
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	f.Detail = redact.Text(f.Detail)
	return &f, nil
}
