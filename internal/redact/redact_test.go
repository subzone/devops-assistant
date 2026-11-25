package redact

import (
	"strings"
	"testing"
)

func TestTextPatterns(t *testing.T) {
	cases := []string{
		"key AKIAABCDEFGHIJKLMNOP here",
		"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
		"postgres://admin:hunter2@db:5432/app",
		"DB_PASSWORD=supersecret",
		`"client_secret": "abc123xyz"`,
		"Authorization: Bearer abc.def.ghi",
		"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
		"-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
	}
	secrets := []string{"AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9", "hunter2", "supersecret", "abc123xyz", "abc.def.ghi", "ghp_abc", "MIIE"}
	for i, c := range cases {
		out := Text(c)
		if strings.Contains(out, secrets[i]) {
			t.Errorf("case %d not redacted: %q", i, out)
		}
	}
}

func TestSecretObject(t *testing.T) {
	in := `{"kind":"Secret","metadata":{"name":"db","annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"data\":{\"pw\":\"aHVudGVyMg==\"}}"}},"data":{"pw":"aHVudGVyMg=="},"stringData":{"x":"plain"}}`
	out := string(JSON([]byte(in)))
	for _, s := range []string{"aHVudGVyMg==", "plain"} {
		if strings.Contains(out, s) {
			t.Fatalf("secret leaked: %s", out)
		}
	}
	if !strings.Contains(out, `"pw"`) {
		t.Fatalf("keys should remain visible: %s", out)
	}
}

func TestSecretList(t *testing.T) {
	in := `{"kind":"List","items":[{"kind":"Secret","data":{"a":"c2VjcmV0"}}]}`
	if strings.Contains(string(JSON([]byte(in))), "c2VjcmV0") {
		t.Fatal("list item secret leaked")
	}
}

func TestEnvValues(t *testing.T) {
	in := `{"kind":"Pod","spec":{"containers":[{"env":[{"name":"API_TOKEN","value":"t0k3n"},{"name":"LOG_LEVEL","value":"debug"}]}]}}`
	out := string(JSON([]byte(in)))
	if strings.Contains(out, "t0k3n") {
		t.Fatal("env token leaked")
	}
	if !strings.Contains(out, "debug") {
		t.Fatal("non-sensitive env removed")
	}
}
