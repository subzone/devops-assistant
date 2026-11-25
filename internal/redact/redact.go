// Package redact removes credentials from anything before it reaches the
// model, the TUI, or the audit log.
package redact

import (
	"encoding/json"
	"regexp"
	"strings"
)

const Mask = "[REDACTED]"

var patterns = []*regexp.Regexp{
	// PEM private keys / certs with keys
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
	// JWT
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b`),
	// AWS access key id
	regexp.MustCompile(`\b(AKIA|ASIA)[0-9A-Z]{16}\b`),
	// GitHub tokens
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{30,}\b`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{40,}\b`),
	// Slack, Grafana service account, generic sk- keys
	regexp.MustCompile(`\bxox[abpors]-[A-Za-z0-9-]{10,}\b`),
	regexp.MustCompile(`\bglsa_[A-Za-z0-9_]{20,}\b`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`),
	// Azure storage account key / SAS sig
	regexp.MustCompile(`(?i)AccountKey=[A-Za-z0-9+/=]{20,}`),
	regexp.MustCompile(`(?i)\bsig=[A-Za-z0-9%+/=]{20,}`),
	// credentials inside URLs: scheme://user:pass@host
	regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://[^:/\s@]+):[^@\s/]+@`),
	// key=value / key: value for sensitive key names
	regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*(password|passwd|secret|token|apikey|api_key|access_key|private_key|client_secret)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)`),
	// Authorization headers
	regexp.MustCompile(`(?i)(authorization\s*[:=]\s*)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+`),
}

// Text scrubs secrets from free text (logs, events, command output).
func Text(s string) string {
	for i, p := range patterns {
		switch i {
		case 10: // URL creds
			s = p.ReplaceAllString(s, "$1:"+Mask+"@")
		case 11: // key=value
			s = p.ReplaceAllString(s, "$1$3"+Mask)
		case 12:
			s = p.ReplaceAllString(s, "$1$2 "+Mask)
		default:
			s = p.ReplaceAllString(s, Mask)
		}
	}
	return s
}

var manifestCred = regexp.MustCompile(`(?im)^\s*-?\s*[A-Za-z0-9_]*(password|passwd|pwd|apikey|api_key|secret|token|private_key)["']?\s*:\s*["']?[^\s"'{}\[\]$]{4,}`)

// ContainsCredential reports high-confidence credentials in config/manifest
// text. It skips the generic key-name rule used for log masking, so
// references like secretKeyRef/secretStoreRef don't trigger it.
func ContainsCredential(s string) bool {
	for i, p := range patterns {
		if i == 11 || i == 12 {
			continue
		}
		if p.MatchString(s) {
			return true
		}
	}
	return manifestCred.MatchString(s) || patterns[12].MatchString(s)
}

var sensitiveName = regexp.MustCompile(`(?i)(password|passwd|secret|token|apikey|api_key|access_key|private_key|credential|client_secret|connection_?string|dsn)`)

// JSON scrubs a Kubernetes JSON document (object or List). On parse failure
// it falls back to Text.
func JSON(b []byte) []byte {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return []byte(Text(string(b)))
	}
	v = walk(v, "")
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return []byte(Text(string(b)))
	}
	return out
}

// Value scrubs an already-decoded JSON value.
func Value(v any) any { return walk(v, "") }

func walk(v any, key string) any {
	switch t := v.(type) {
	case map[string]any:
		return walkMap(t)
	case []any:
		for i := range t {
			t[i] = walk(t[i], key)
		}
		return t
	case string:
		return Text(t)
	default:
		return v
	}
}

func walkMap(m map[string]any) map[string]any {
	kind, _ := m["kind"].(string)
	if strings.EqualFold(kind, "Secret") {
		for _, f := range []string{"data", "stringData"} {
			if d, ok := m[f].(map[string]any); ok {
				for k := range d {
					d[k] = Mask
				}
			}
		}
	}
	// last-applied-configuration can embed full Secret bodies.
	if md, ok := m["metadata"].(map[string]any); ok {
		if ann, ok := md["annotations"].(map[string]any); ok {
			if _, ok := ann["kubectl.kubernetes.io/last-applied-configuration"]; ok {
				ann["kubectl.kubernetes.io/last-applied-configuration"] = Mask
			}
		}
	}
	// env: [{name, value}] with sensitive names
	if name, ok := m["name"].(string); ok {
		if _, hasVal := m["value"].(string); hasVal && sensitiveName.MatchString(name) {
			m["value"] = Mask
		}
	}
	for k, val := range m {
		if s, ok := val.(string); ok && sensitiveName.MatchString(k) && k != "secretName" && k != "secretRef" && s != Mask {
			m[k] = Mask
			continue
		}
		m[k] = walk(val, k)
	}
	return m
}
