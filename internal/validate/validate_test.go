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

func TestTerraformCredentialFails(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "main.tf"), []byte(`provider "hcloud" {
  token = "abcdef1234567890abcdef"
}
resource "hcloud_server" "a" { name = "a" }
`), 0o600)
	r, err := Run(context.Background(), d, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if r.Passed {
		t.Fatalf("hard-coded hcloud token passed: %+v", r.Stages)
	}
}

func TestTerraformCleanPassesBuiltin(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "main.tf"), []byte(`terraform {
  required_providers {
    hcloud = { source = "hetznercloud/hcloud", version = "~> 1.49" }
  }
  backend "s3" {}
}
provider "hcloud" {}
`), 0o600)
	r, _ := Run(context.Background(), d, Options{})
	for _, s := range r.Stages {
		if s.Name == "secrets (builtin)" && s.Status != Pass {
			t.Fatalf("clean module failed secrets: %s", s.Output)
		}
	}
}

func TestCrossplaneOrphanWarning(t *testing.T) {
	p := write(t, "apiVersion: s3.aws.upbound.io/v1beta1\nkind: Bucket\nmetadata:\n  name: data\nspec:\n  forProvider:\n    region: eu-central-1\n  providerConfigRef:\n    name: default\n")
	r, _ := Run(context.Background(), p, Options{})
	found := false
	for _, s := range r.Stages {
		if s.Name == "crossplane hygiene (builtin)" && s.Status == Fail {
			found = true
		}
	}
	if !found {
		t.Fatal("missing deletionPolicy warning")
	}
}
