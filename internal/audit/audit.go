// Package audit appends redacted JSONL records to ~/.k8sh/audit.log.
package audit

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/subzone/k8s-handler/internal/redact"
)

type Record struct {
	Time    time.Time      `json:"time"`
	Source  string         `json:"source"` // mcp | hook | cli
	Event   string         `json:"event"`  // tool name or command
	Outcome string         `json:"outcome"`
	Detail  map[string]any `json:"detail,omitempty"`
}

var mu sync.Mutex

func Write(home string, r Record) {
	if home == "" {
		return
	}
	r.Time = time.Now().UTC()
	if r.Detail != nil {
		r.Detail, _ = redact.Value(r.Detail).(map[string]any)
	}
	b, err := json.Marshal(r)
	if err != nil {
		return
	}
	mu.Lock()
	defer mu.Unlock()
	os.MkdirAll(home, 0o700)
	f, err := os.OpenFile(filepath.Join(home, "audit.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	f.Write(append(b, '\n'))
}
