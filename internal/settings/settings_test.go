package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMergeKeepsExisting(t *testing.T) {
	p := filepath.Join(t.TempDir(), "settings.json")
	os.WriteFile(p, []byte(`{"model":"opus","permissions":{"allow":["Bash(ls:*)"],"deny":["Read(./secrets/**)","Bash(kubectl delete:*)"]},"statusLine":{"type":"command","command":"mine"}}`), 0o600)
	r, err := Apply(p, "k8sh statusline", false, false)
	if err != nil {
		t.Fatal(err)
	}
	if r.StatusLine != "kept-existing" {
		t.Fatal("existing statusLine replaced without force")
	}
	var doc map[string]any
	b, _ := os.ReadFile(p)
	json.Unmarshal(b, &doc)
	perms := doc["permissions"].(map[string]any)
	deny := perms["deny"].([]any)
	if deny[0] != "Read(./secrets/**)" || len(deny) != len(DenyRules)+1 {
		t.Fatalf("deny merge wrong: %v", deny)
	}
	if len(perms["allow"].([]any)) != 1 || doc["model"] != "opus" {
		t.Fatal("unrelated settings changed")
	}
	if _, err := os.Stat(p + ".bak"); err != nil {
		t.Fatal("no backup")
	}
	// idempotent
	r, _ = Apply(p, "k8sh statusline", false, false)
	if len(r.AddedDeny) != 0 {
		t.Fatal("not idempotent")
	}
}

func TestCreatesNewAndRejectsInvalid(t *testing.T) {
	d := t.TempDir()
	p := filepath.Join(d, "settings.json")
	if r, err := Apply(p, "k8sh statusline", false, false); err != nil || r.StatusLine != "set" {
		t.Fatalf("create failed: %v %+v", err, r)
	}
	bad := filepath.Join(d, "bad.json")
	os.WriteFile(bad, []byte("{not json"), 0o600)
	if _, err := Apply(bad, "", false, false); err == nil {
		t.Fatal("invalid JSON overwritten")
	}
}
