package validate

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, content string) string {
	t.Helper()
	d := t.TempDir()
	p := filepath.Join(d, "m.yaml")
	os.WriteFile(p, []byte(content), 0o600)
	return p
}

func TestPlainSecretFails(t *testing.T) {
	p := write(t, "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\ndata:\n  pw: aGk=\n")
	r, err := Run(context.Background(), p, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Passed {
		t.Fatal("plain Secret passed validation")
	}
}

func TestCleanManifestPasses(t *testing.T) {
	p := write(t, `apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db
spec:
  secretStoreRef: {name: vault, kind: ClusterSecretStore}
  target: {name: db}
  data:
  - secretKey: pw
    remoteRef: {key: apps/db, property: pw}
`)
	r, err := Run(context.Background(), p, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if !r.Passed {
		t.Fatalf("clean manifest failed: %+v", r.Stages)
	}
}

func TestStrictFailsWhenToolsMissing(t *testing.T) {
	t.Setenv("PATH", "")
	p := write(t, "kind: ConfigMap\nmetadata:\n  name: x\n")
	r, _ := Run(context.Background(), p, Options{Strict: true})
	if r.Passed {
		t.Fatal("strict mode passed without scanners")
	}
}

func TestInlinePasswordFails(t *testing.T) {
	p := write(t, "kind: ConfigMap\nmetadata:\n  name: x\ndata:\n  DB_PASSWORD: hunter22\n")
	r, _ := Run(context.Background(), p, Options{})
	if r.Passed {
		t.Fatal("inline password passed")
	}
}

func TestTokenKeyFails(t *testing.T) {
	p := write(t, "kind: ConfigMap\nmetadata:\n  name: x\ndata:\n  API_TOKEN: abcdefgh123\n  clientSecret: s3cr3tvalue\n")
	r, _ := Run(context.Background(), p, Options{})
	if r.Passed {
		t.Fatal("token in configmap passed")
	}
}
