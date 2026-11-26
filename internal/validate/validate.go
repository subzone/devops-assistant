// Package validate runs the gated pipeline for generated manifests:
// render -> secrets -> schema -> lint -> policy -> security -> (server dry-run).
// External tools are optional; missing ones are reported as skipped, and
// required stages fail closed when their tool is missing.
package validate

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/subzone/devops-assistant/internal/redact"
)

type Status string

const (
	Pass    Status = "pass"
	Fail    Status = "fail"
	Skipped Status = "skipped"
)

type Stage struct {
	Name     string `json:"name"`
	Status   Status `json:"status"`
	Required bool   `json:"required"`
	Tool     string `json:"tool,omitempty"`
	Output   string `json:"output,omitempty"`
}

type Report struct {
	Path     string  `json:"path"`
	Rendered string  `json:"rendered,omitempty"`
	Stages   []Stage `json:"stages"`
	Passed   bool    `json:"passed"`
}

type Options struct {
	// Strict makes schema and secret-scan tools required (fail if missing).
	Strict bool
	// DryRun, if set, is called with the rendered file for server-side dry-run.
	DryRun func(ctx context.Context, file string) (string, error)
}

func have(tool string) bool { _, err := exec.LookPath(tool); return err == nil }

func run(ctx context.Context, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := redact.Text(out.String())
	if len(s) > 8000 {
		s = s[:8000] + "\n…(truncated)"
	}
	return s, err
}

// Render produces a single manifest file from a dir (kustomize/helm) or file.
func Render(ctx context.Context, path, tmp string) (string, Stage, error) {
	st := Stage{Name: "render", Required: true}
	fi, err := os.Stat(path)
	if err != nil {
		st.Status, st.Output = Fail, err.Error()
		return "", st, err
	}
	out := filepath.Join(tmp, "rendered.yaml")
	if !fi.IsDir() {
		b, err := os.ReadFile(path)
		if err != nil {
			return "", st, err
		}
		st.Status, st.Tool = Pass, "file"
		return out, st, os.WriteFile(out, b, 0o600)
	}
	var text string
	switch {
	case exists(path, "kustomization.yaml") || exists(path, "kustomization.yml") || exists(path, "Kustomization"):
		if have("kustomize") {
			st.Tool = "kustomize"
			text, err = run(ctx, "kustomize", "build", path)
		} else if have("kubectl") {
			st.Tool = "kubectl kustomize"
			text, err = run(ctx, "kubectl", "kustomize", path)
		} else {
			err = errors.New("kustomize/kubectl not installed")
		}
	case exists(path, "Chart.yaml"):
		if !have("helm") {
			err = errors.New("helm not installed")
			break
		}
		st.Tool = "helm"
		text, err = run(ctx, "helm", "template", "k8sh-validate", path)
	default:
		st.Tool = "concat"
		var buf strings.Builder
		err = filepath.WalkDir(path, func(p string, d os.DirEntry, e error) error {
			if e != nil || d.IsDir() || !(strings.HasSuffix(p, ".yaml") || strings.HasSuffix(p, ".yml")) {
				return e
			}
			b, e := os.ReadFile(p)
			buf.WriteString("---\n")
			buf.Write(b)
			buf.WriteString("\n")
			return e
		})
		text = buf.String()
	}
	if err != nil {
		st.Status, st.Output = Fail, text+"\n"+err.Error()
		return "", st, err
	}
	st.Status = Pass
	return out, st, os.WriteFile(out, []byte(text), 0o600)
}

func exists(dir, f string) bool { _, err := os.Stat(filepath.Join(dir, f)); return err == nil }

var (
	docSplit    = regexp.MustCompile(`(?m)^---\s*$`)
	kindSecret  = regexp.MustCompile(`(?m)^kind:\s*Secret\s*$`)
	hasData     = regexp.MustCompile(`(?m)^(data|stringData):\s*$`)
	latestImage = regexp.MustCompile(`(?m)^\s*-?\s*image:\s*["']?[^\s"']+(:latest)?["']?\s*$`)
)

// builtinSecrets fails if any rendered doc is a Secret carrying data, or if
// raw text matches credential patterns.
func builtinSecrets(text string) Stage {
	st := Stage{Name: "secrets (builtin)", Required: true, Tool: "k8sh"}
	var problems []string
	for i, d := range docSplit.Split(text, -1) {
		if kindSecret.MatchString(d) && hasData.MatchString(d) {
			problems = append(problems, fmt.Sprintf("doc %d: kind Secret with data/stringData — use ExternalSecret", i))
		}
	}
	if redact.ContainsCredential(text) {
		problems = append(problems, "credential-like values found (masked); remove them and reference a secret store")
	}
	if len(problems) > 0 {
		st.Status, st.Output = Fail, strings.Join(problems, "\n")
	} else {
		st.Status = Pass
	}
	return st
}

func builtinHygiene(text string) Stage {
	st := Stage{Name: "hygiene (builtin)", Required: false, Tool: "k8sh"}
	var warn []string
	for _, m := range latestImage.FindAllString(text, -1) {
		if strings.Contains(m, ":latest") || !strings.Contains(strings.SplitN(strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(m), "-")), ":", 2)[1], ":") {
			warn = append(warn, "unpinned image: "+strings.TrimSpace(m))
		}
	}
	if strings.Contains(text, "kind: Deployment") && !strings.Contains(text, "resources:") {
		warn = append(warn, "workloads without resources requests/limits")
	}
	if strings.Contains(text, "privileged: true") {
		warn = append(warn, "privileged container")
	}
	if len(warn) > 0 {
		st.Status, st.Output = Fail, strings.Join(warn, "\n")
	} else {
		st.Status = Pass
	}
	return st
}

func tool(ctx context.Context, name string, required bool, bin string, args ...string) Stage {
	st := Stage{Name: name, Required: required, Tool: bin}
	if !have(bin) {
		st.Status, st.Output = Skipped, bin+" not installed"
		if required {
			st.Status = Fail
			st.Output += " (required in strict mode)"
		}
		return st
	}
	out, err := run(ctx, bin, args...)
	st.Output = out
	if err != nil {
		st.Status = Fail
	} else {
		st.Status = Pass
	}
	return st
}

// Run executes the pipeline.
func Run(ctx context.Context, path string, o Options) (*Report, error) {
	tmp, err := os.MkdirTemp("", "k8sh-validate-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	if IsTerraform(path) {
		return RunTerraform(ctx, path, o)
	}
	rep := &Report{Path: path}
	file, st, err := Render(ctx, path, tmp)
	rep.Stages = append(rep.Stages, st)
	if err != nil {
		return finish(rep), nil
	}
	b, _ := os.ReadFile(file)
	text := string(b)
	rep.Stages = append(rep.Stages,
		builtinSecrets(text),
		tool(ctx, "secrets (gitleaks)", o.Strict, "gitleaks", "detect", "--no-git", "--redact", "--no-banner", "--source", path),
		tool(ctx, "schema (kubeconform)", o.Strict, "kubeconform", "-strict", "-summary", "-ignore-missing-schemas", file),
		tool(ctx, "lint (kube-linter)", false, "kube-linter", "lint", file),
		tool(ctx, "policy (kyverno)", false, "kyverno", "apply", policyDir(path), "--resource", file),
		tool(ctx, "security (trivy)", false, "trivy", "config", "--quiet", "--exit-code", "1", "--severity", "HIGH,CRITICAL", file),
		builtinHygiene(text),
	)
	rep.Stages = append(rep.Stages, crossplaneStages(ctx, text, file)...)
	// kyverno requires a policy dir; skip if none
	for i := range rep.Stages {
		if rep.Stages[i].Name == "policy (kyverno)" && policyDir(path) == "" {
			rep.Stages[i].Status, rep.Stages[i].Output = Skipped, "no policies/ directory found"
		}
	}
	if o.DryRun != nil {
		st := Stage{Name: "server dry-run", Required: true, Tool: "kubectl"}
		out, err := o.DryRun(ctx, file)
		st.Output = out
		if err != nil {
			st.Status, st.Output = Fail, out+"\n"+err.Error()
		} else {
			st.Status = Pass
		}
		rep.Stages = append(rep.Stages, st)
	}
	return finish(rep), nil
}

func policyDir(path string) string {
	dir := path
	for i := 0; i < 5; i++ {
		p := filepath.Join(dir, "policies")
		if fi, err := os.Stat(p); err == nil && fi.IsDir() {
			return p
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func finish(r *Report) *Report {
	r.Passed = true
	for _, s := range r.Stages {
		if s.Required && s.Status == Fail {
			r.Passed = false
		}
	}
	return r
}
