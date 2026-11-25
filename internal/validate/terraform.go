package validate

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/subzone/k8s-handler/internal/redact"
)

// IsTerraform reports whether path is (or contains at top level) Terraform/OpenTofu code.
func IsTerraform(path string) bool {
	fi, err := os.Stat(path)
	if err != nil {
		return false
	}
	if !fi.IsDir() {
		return strings.HasSuffix(path, ".tf") || strings.HasSuffix(path, ".tofu")
	}
	m, _ := filepath.Glob(filepath.Join(path, "*.tf"))
	m2, _ := filepath.Glob(filepath.Join(path, "*.tofu"))
	return len(m)+len(m2) > 0
}

func tfBinary() string {
	if have("tofu") {
		return "tofu"
	}
	if have("terraform") {
		return "terraform"
	}
	return ""
}

func runIn(ctx context.Context, dir string, env []string, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	s := redact.Text(out.String())
	if len(s) > 8000 {
		s = s[:8000] + "\n…(truncated)"
	}
	return s, err
}

func toolIn(ctx context.Context, name string, required bool, dir string, env []string, bin string, args ...string) Stage {
	st := Stage{Name: name, Required: required, Tool: bin}
	if bin == "" || !have(bin) {
		st.Status, st.Output = Skipped, name+": tool not installed"
		if required {
			st.Status = Fail
			st.Output += " (required in strict mode)"
		}
		return st
	}
	out, err := runIn(ctx, dir, env, bin, args...)
	st.Output = out
	if err != nil {
		st.Status = Fail
	} else {
		st.Status = Pass
	}
	return st
}

var (
	tfProviderCred = regexp.MustCompile(`(?m)^\s*(access_key|secret_key|token|client_secret|password|api_key|secret_id|private_key)\s*=\s*"[^"$]{4,}"`)
	tfBackend      = regexp.MustCompile(`(?m)^\s*(backend|cloud)\s+("[a-z0-9]+"\s*)?\{`)
	tfReqProv      = regexp.MustCompile(`(?s)required_providers\s*\{`)
	tfVersionPin   = regexp.MustCompile(`version\s*=\s*"`)
	tfPreventDel   = regexp.MustCompile(`prevent_destroy\s*=\s*true`)
	tfStateful     = regexp.MustCompile(`resource\s+"(aws_db_instance|aws_rds_cluster|aws_s3_bucket|aws_dynamodb_table|azurerm_(mssql|postgresql|mysql)\w*|azurerm_storage_account|google_sql_database_instance|google_storage_bucket|hcloud_volume|digitalocean_database_cluster|digitalocean_volume|alicloud_db_instance|alicloud_oss_bucket)"`)
)

func readTF(dir string) string {
	var b strings.Builder
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && (d.Name() == ".terraform" || d.Name() == ".git") {
			return filepath.SkipDir
		}
		if !d.IsDir() && (strings.HasSuffix(p, ".tf") || strings.HasSuffix(p, ".tofu") || strings.HasSuffix(p, ".tfvars")) {
			c, _ := os.ReadFile(p)
			b.WriteString("\n# file: " + p + "\n")
			b.Write(c)
		}
		return nil
	})
	return b.String()
}

func builtinTF(text string) []Stage {
	sec := Stage{Name: "secrets (builtin)", Required: true, Tool: "k8sh"}
	var probs []string
	if tfProviderCred.MatchString(text) || redact.ContainsCredential(text) {
		probs = append(probs, "hard-coded credential found (masked). Use env/OIDC/workload identity or a secret store, never literals in .tf/.tfvars")
	}
	if len(probs) > 0 {
		sec.Status, sec.Output = Fail, strings.Join(probs, "\n")
	} else {
		sec.Status = Pass
	}
	hyg := Stage{Name: "hygiene (builtin)", Tool: "k8sh"}
	var warn []string
	if !tfBackend.MatchString(text) {
		warn = append(warn, "no remote backend/cloud block: state would be local (use S3/AzureRM/GCS/remote backend with locking)")
	}
	if tfReqProv.MatchString(text) && !tfVersionPin.MatchString(text) {
		warn = append(warn, "required_providers without version constraints")
	}
	if !tfReqProv.MatchString(text) {
		warn = append(warn, "no required_providers block (pin provider sources and versions)")
	}
	if tfStateful.MatchString(text) && !tfPreventDel.MatchString(text) {
		warn = append(warn, "stateful resources without lifecycle { prevent_destroy = true }")
	}
	if len(warn) > 0 {
		hyg.Status, hyg.Output = Fail, strings.Join(warn, "\n")
	} else {
		hyg.Status = Pass
	}
	return []Stage{sec, hyg}
}

// RunTerraform validates a Terraform/OpenTofu root module directory without
// touching real state: init runs with -backend=false and a throwaway data dir.
func RunTerraform(ctx context.Context, path string, o Options) (*Report, error) {
	dir := path
	if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
		dir = filepath.Dir(path)
	}
	tmp, err := os.MkdirTemp("", "k8sh-tf-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmp)
	env := []string{"TF_DATA_DIR=" + filepath.Join(tmp, "data"), "TF_IN_AUTOMATION=1", "TF_INPUT=0", "CHECKPOINT_DISABLE=1"}
	tf := tfBinary()
	rep := &Report{Path: path}
	rep.Stages = append(rep.Stages, Stage{Name: "render", Required: true, Tool: "terraform", Status: Pass, Output: "terraform/opentofu module: " + dir})
	rep.Stages = append(rep.Stages, builtinTF(readTF(dir))...)
	rep.Stages = append(rep.Stages,
		tool(ctx, "secrets (gitleaks)", o.Strict, "gitleaks", "detect", "--no-git", "--redact", "--no-banner", "--source", dir),
		toolIn(ctx, "fmt", o.Strict, dir, env, tf, "fmt", "-check", "-recursive", "-diff"),
	)
	initSt := toolIn(ctx, "init (no backend)", false, dir, env, tf, "init", "-backend=false", "-input=false", "-no-color")
	rep.Stages = append(rep.Stages, initSt)
	if initSt.Status == Pass {
		rep.Stages = append(rep.Stages, toolIn(ctx, "validate", true, dir, env, tf, "validate", "-no-color"))
	} else {
		rep.Stages = append(rep.Stages, Stage{Name: "validate", Tool: tf, Status: Skipped, Output: "init failed or terraform/tofu missing (providers need network)"})
	}
	rep.Stages = append(rep.Stages,
		toolIn(ctx, "lint (tflint)", false, dir, nil, "tflint", "--recursive", "--no-color"),
		tool(ctx, "security (trivy)", false, "trivy", "config", "--quiet", "--exit-code", "1", "--severity", "HIGH,CRITICAL", dir),
		tool(ctx, "security (checkov)", false, "checkov", "-d", dir, "--quiet", "--compact", "--framework", "terraform"),
		toolIn(ctx, "cost estimate (infracost)", false, dir, nil, "infracost", "breakdown", "--path", ".", "--no-color"),
	)
	// cost estimate is informational
	for i := range rep.Stages {
		if strings.HasPrefix(rep.Stages[i].Name, "cost estimate") && rep.Stages[i].Status == Fail {
			rep.Stages[i].Status = Skipped
			rep.Stages[i].Output = "infracost failed (needs INFRACOST_API_KEY in your env): " + rep.Stages[i].Output
		}
	}
	return finish(rep), nil
}

var crossplaneRe = regexp.MustCompile(`(?m)^apiVersion:\s*\S*(crossplane\.io|upbound\.io|crossplane-contrib)`)
var mrRe = regexp.MustCompile(`(?m)^\s*providerConfigRef:`)

// crossplaneStages adds Crossplane checks when the rendered YAML has Crossplane objects.
func crossplaneStages(ctx context.Context, text, file string) []Stage {
	if !crossplaneRe.MatchString(text) && !mrRe.MatchString(text) {
		return nil
	}
	st := []Stage{tool(ctx, "crossplane validate", false, "crossplane", "beta", "validate", file, file)}
	hyg := Stage{Name: "crossplane hygiene (builtin)", Tool: "k8sh", Status: Pass}
	var warn []string
	if mrRe.MatchString(text) && !strings.Contains(text, "deletionPolicy: Orphan") && !strings.Contains(text, "managementPolicies") {
		warn = append(warn, "managed resources default to deletionPolicy: Delete — deleting the object in Git deletes the cloud resource. Use deletionPolicy: Orphan (or managementPolicies without Delete) for stateful/prod resources")
	}
	if strings.Contains(text, "kind: ProviderConfig") && strings.Contains(text, "source: Secret") {
		warn = append(warn, "ProviderConfig uses a static Secret: prefer IRSA/Pod Identity (AWS), Workload Identity (Azure/GCP), or an ExternalSecret-managed secret")
	}
	if len(warn) > 0 {
		hyg.Status, hyg.Output = Fail, strings.Join(warn, "\n")
	}
	return append(st, hyg)
}
