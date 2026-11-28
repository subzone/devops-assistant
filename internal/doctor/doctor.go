// Package doctor reports which external tools devops-assistant can use on
// this machine, per feature, and how to install the missing ones. It only
// looks (PATH lookups and version flags); it never installs anything.
package doctor

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Group is a feature that needs a set of tools.
type Group struct {
	ID, Title, Why string
}

var Groups = []Group{
	{"core", "Core", "k8sh, the guard, the MCP tools and the k8s pane"},
	{"gitops", "GitOps", "rendering and inspecting Helm, Kustomize and Argo CD"},
	{"validate", "Validation", "validate_manifests stages for Kubernetes manifests"},
	{"iac", "Infrastructure as code", "validate_manifests stages for Terraform/OpenTofu and Crossplane"},
	{"security", "Security scanners", "cloud and cluster posture (cloud-security skill)"},
	{"cloud", "Cloud CLIs", "costs, logs, inventory and security per cloud (use whichever clouds you have)"},
	{"onprem", "On-prem", "vSphere and bare-metal analysis (onprem-ops skill)"},
	{"design", "Design rendering", "SVGs of design diagrams (Mermaid renders on GitHub without these)"},
	{"pane", "k8s pane extras", "the standalone TUI and Steve's voice and ears"},
}

// Tool is one external program (or a data file, when Bin is empty and File is set).
type Tool struct {
	Name     string
	Group    string
	Bin      string   // executable to look for
	Alt      []string // alternatives that satisfy the same need (e.g. tofu for terraform)
	File     string   // a data file instead of a program (~ expands to home)
	Required bool
	Why      string
	Version  []string // args that print a version; nil = don't run it
	Brew     string   // formula, or "--cask name"
	Apt      string
	Pipx     string
	Go       string // go install path
	Get      string // a shell command for files (models)
	URL      string // official install docs
}

var Tools = []Tool{
	{Name: "kubectl", Group: "core", Bin: "kubectl", Required: true, Why: "every cluster read", Version: []string{"version", "--client"}, Brew: "kubectl", URL: "https://kubernetes.io/docs/tasks/tools/"},
	{Name: "git", Group: "core", Bin: "git", Required: true, Why: "GitOps changes and PRs", Version: []string{"--version"}, Brew: "git", Apt: "git", URL: "https://git-scm.com/downloads"},
	{Name: "go", Group: "core", Bin: "go", Why: "builds k8sh from source when no release binary is available", Version: []string{"version"}, Brew: "go", Apt: "golang-go", URL: "https://go.dev/dl/"},

	{Name: "helm", Group: "gitops", Bin: "helm", Why: "render and lint charts", Version: []string{"version", "--short"}, Brew: "helm", URL: "https://helm.sh/docs/intro/install/"},
	{Name: "kustomize", Group: "gitops", Bin: "kustomize", Why: "build overlays (kubectl kustomize works too)", Version: []string{"version"}, Brew: "kustomize", Go: "sigs.k8s.io/kustomize/kustomize/v5@latest", URL: "https://kubectl.docs.kubernetes.io/installation/kustomize/"},
	{Name: "argocd", Group: "gitops", Bin: "argocd", Why: "Argo CD CLI reads (the MCP tools use kubectl)", Version: []string{"version", "--client", "--short"}, Brew: "argocd", URL: "https://argo-cd.readthedocs.io/en/stable/cli_installation/"},

	{Name: "kubeconform", Group: "validate", Bin: "kubeconform", Why: "schema validation", Version: []string{"-v"}, Brew: "kubeconform", Go: "github.com/yannh/kubeconform/cmd/kubeconform@latest", URL: "https://github.com/yannh/kubeconform"},
	{Name: "kube-linter", Group: "validate", Bin: "kube-linter", Why: "best-practice lint", Version: []string{"version"}, Brew: "kube-linter", Go: "golang.stackrox.io/kube-linter/cmd/kube-linter@latest", URL: "https://github.com/stackrox/kube-linter"},
	{Name: "gitleaks", Group: "validate", Bin: "gitleaks", Why: "secret scan (a builtin scan runs either way)", Version: []string{"version"}, Brew: "gitleaks", URL: "https://github.com/gitleaks/gitleaks"},
	{Name: "trivy", Group: "validate", Bin: "trivy", Why: "misconfiguration scan for manifests and Terraform", Version: []string{"--version"}, Brew: "trivy", URL: "https://trivy.dev/latest/getting-started/installation/"},
	{Name: "kyverno", Group: "validate", Bin: "kyverno", Why: "policy checks when the repo has policies/", Version: []string{"version"}, Brew: "kyverno", URL: "https://kyverno.io/docs/kyverno-cli/install/"},

	{Name: "terraform", Group: "iac", Bin: "terraform", Alt: []string{"tofu"}, Why: "fmt/validate for Terraform (or OpenTofu)", Version: []string{"version"}, Brew: "hashicorp/tap/terraform", URL: "https://developer.hashicorp.com/terraform/install"},
	{Name: "tflint", Group: "iac", Bin: "tflint", Why: "Terraform lint", Version: []string{"--version"}, Go: "github.com/terraform-linters/tflint@latest", URL: "https://github.com/terraform-linters/tflint#installation"},
	{Name: "checkov", Group: "iac", Bin: "checkov", Why: "Terraform security scan", Version: []string{"--version"}, Brew: "checkov", Pipx: "checkov", URL: "https://www.checkov.io/2.Basics/Installing%20Checkov.html"},
	{Name: "infracost", Group: "iac", Bin: "infracost", Why: "cost estimate before deploy (needs a free API key in your env)", Version: []string{"--version"}, Brew: "infracost", URL: "https://www.infracost.io/docs/"},
	{Name: "crossplane", Group: "iac", Bin: "crossplane", Why: "crossplane beta validate", Version: []string{"--version"}, Brew: "crossplane", URL: "https://docs.crossplane.io/latest/cli/"},

	{Name: "prowler", Group: "security", Bin: "prowler", Why: "cloud and Kubernetes posture scan (else quick checks)", Version: []string{"--version"}, Brew: "prowler", Pipx: "prowler", URL: "https://docs.prowler.com/"},
	{Name: "kubescape", Group: "security", Bin: "kubescape", Why: "Kubernetes posture frameworks (NSA, MITRE, CIS)", Version: []string{"version"}, Brew: "kubescape", URL: "https://kubescape.io/docs/install-cli/"},

	{Name: "aws", Group: "cloud", Bin: "aws", Why: "AWS", Version: []string{"--version"}, Brew: "awscli", URL: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"},
	{Name: "az", Group: "cloud", Bin: "az", Why: "Azure", Version: nil, Brew: "--cask azure-cli", URL: "https://learn.microsoft.com/cli/azure/install-azure-cli"},
	{Name: "gcloud", Group: "cloud", Bin: "gcloud", Why: "GCP", Version: nil, Brew: "--cask gcloud-cli", URL: "https://cloud.google.com/sdk/docs/install"},
	{Name: "hcloud", Group: "cloud", Bin: "hcloud", Why: "Hetzner Cloud", Version: []string{"version"}, Brew: "hcloud", URL: "https://github.com/hetznercloud/cli"},
	{Name: "doctl", Group: "cloud", Bin: "doctl", Why: "DigitalOcean", Version: []string{"version"}, Brew: "doctl", URL: "https://docs.digitalocean.com/reference/doctl/how-to/install/"},
	{Name: "aliyun", Group: "cloud", Bin: "aliyun", Why: "Alibaba Cloud", Version: []string{"version"}, Brew: "aliyun-cli", URL: "https://www.alibabacloud.com/help/en/cli/"},

	{Name: "govc", Group: "onprem", Bin: "govc", Why: "VMware vSphere", Version: []string{"version"}, Brew: "govc", URL: "https://github.com/vmware/govmomi/tree/main/govc"},
	{Name: "ansible", Group: "onprem", Bin: "ansible", Why: "bare-metal facts (setup, package_facts)", Version: []string{"--version"}, Brew: "ansible", Apt: "ansible", Pipx: "--include-deps ansible", URL: "https://docs.ansible.com/ansible/latest/installation_guide/"},

	{Name: "mmdc", Group: "design", Bin: "mmdc", Why: "Mermaid → SVG", Version: []string{"--version"}, Brew: "mermaid-cli", URL: "https://github.com/mermaid-js/mermaid-cli"},
	{Name: "d2", Group: "design", Bin: "d2", Why: "D2 → SVG", Version: []string{"--version"}, Brew: "d2", URL: "https://d2lang.com/tour/install"},

	{Name: "tmux", Group: "pane", Bin: "tmux", Why: "k8sh workspace and tui --open", Version: []string{"-V"}, Brew: "tmux", Apt: "tmux", URL: "https://github.com/tmux/tmux/wiki/Installing"},
	{Name: "piper", Group: "pane", Bin: "piper", Why: "Steve's neural voice (else macOS say)", Pipx: "piper-tts", URL: "https://github.com/OHF-Voice/piper1-gpl"},
	{Name: "piper voice", Group: "pane", File: "~/.local/share/piper-voices/en_US-ryan-medium.onnx", Why: "the Ryan voice Steve uses by default", Get: `"$(pipx environment --value PIPX_LOCAL_VENVS)/piper-tts/bin/python" -m piper.download_voices --download-dir ~/.local/share/piper-voices en_US-ryan-medium`},
	{Name: "ffmpeg", Group: "pane", Bin: "ffmpeg", Why: "records the microphone for 🎤 talk", Brew: "ffmpeg", Apt: "ffmpeg", URL: "https://ffmpeg.org/download.html"},
	{Name: "whisper-cli", Group: "pane", Bin: "whisper-cli", Why: "speech to text for 🎤 talk, on this machine", Brew: "whisper-cpp", URL: "https://github.com/ggml-org/whisper.cpp"},
	{Name: "whisper model", Group: "pane", File: "~/.local/share/whisper-models/ggml-base.en.bin", Why: "the English model whisper-cli uses (~150 MB)", Get: "mkdir -p ~/.local/share/whisper-models && curl -fL -o ~/.local/share/whisper-models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"},
}

// Item is the result for one tool.
type Item struct {
	Name     string `json:"name"`
	Required bool   `json:"required,omitempty"`
	Found    bool   `json:"found"`
	Path     string `json:"path,omitempty"`
	Version  string `json:"version,omitempty"`
	Why      string `json:"why"`
	Install  string `json:"install,omitempty"`
	Docs     string `json:"docs,omitempty"`
}

type GroupReport struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Why     string `json:"why"`
	Found   int    `json:"found"`
	Missing int    `json:"missing"`
	Items   []Item `json:"items"`
}

type Report struct {
	OS              string        `json:"os"`
	Arch            string        `json:"arch"`
	Managers        []string      `json:"packageManagers"`
	RequiredMissing []string      `json:"requiredMissing"`
	Groups          []GroupReport `json:"groups"`
}

// Env is what Check looks at; tests replace it.
type Env struct {
	Home     string
	LookPath func(string) (string, error)
	Exists   func(string) bool
	Run      func(ctx context.Context, bin string, args ...string) string
	OS       string
}

func DefaultEnv() Env {
	home, _ := os.UserHomeDir()
	extra := []string{"/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", filepath.Join(home, ".local/bin"), filepath.Join(home, "go/bin")}
	return Env{
		Home: home,
		OS:   runtime.GOOS,
		LookPath: func(name string) (string, error) {
			if p, err := exec.LookPath(name); err == nil {
				return p, nil
			}
			for _, d := range extra {
				p := filepath.Join(d, name)
				if st, err := os.Stat(p); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
					return p, nil
				}
			}
			return "", exec.ErrNotFound
		},
		Exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		Run: func(ctx context.Context, bin string, args ...string) string {
			ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
			defer cancel()
			out, _ := exec.CommandContext(ctx, bin, args...).CombinedOutput()
			return string(out)
		},
	}
}

// Wanted turns a comma list ("" or "all" = every group) into a set.
func Wanted(list string) map[string]bool {
	w := map[string]bool{}
	for _, g := range strings.Split(list, ",") {
		if g = strings.TrimSpace(strings.ToLower(g)); g != "" && g != "all" {
			w[g] = true
		}
	}
	return w
}

// Check looks for every tool of the wanted groups (all when empty).
func Check(ctx context.Context, env Env, groups map[string]bool) Report {
	r := Report{OS: env.OS, Arch: runtime.GOARCH, RequiredMissing: []string{}}
	for _, m := range []string{"brew", "apt-get", "pipx", "go"} {
		if _, err := env.LookPath(m); err == nil {
			r.Managers = append(r.Managers, strings.TrimSuffix(m, "-get"))
		}
	}
	items := make([]Item, len(Tools))
	var wg sync.WaitGroup
	for i, t := range Tools {
		if len(groups) > 0 && !groups[t.Group] {
			continue
		}
		wg.Add(1)
		go func(i int, t Tool) {
			defer wg.Done()
			items[i] = check(ctx, env, t, r.Managers)
		}(i, t)
	}
	wg.Wait()
	for _, g := range Groups {
		if len(groups) > 0 && !groups[g.ID] {
			continue
		}
		gr := GroupReport{ID: g.ID, Title: g.Title, Why: g.Why, Items: []Item{}}
		for i, t := range Tools {
			if t.Group != g.ID {
				continue
			}
			it := items[i]
			gr.Items = append(gr.Items, it)
			if it.Found {
				gr.Found++
			} else {
				gr.Missing++
				if it.Required {
					r.RequiredMissing = append(r.RequiredMissing, it.Name)
				}
			}
		}
		r.Groups = append(r.Groups, gr)
	}
	return r
}

func check(ctx context.Context, env Env, t Tool, managers []string) Item {
	it := Item{Name: t.Name, Required: t.Required, Why: t.Why, Docs: t.URL}
	if t.File != "" {
		p := expand(env.Home, t.File)
		if env.Exists(p) {
			it.Found, it.Path = true, p
		} else {
			it.Install = t.Get
		}
		return it
	}
	for _, b := range append([]string{t.Bin}, t.Alt...) {
		if p, err := env.LookPath(b); err == nil {
			it.Found, it.Path = true, p
			if t.Version != nil {
				it.Version = firstLine(env.Run(ctx, p, t.Version...))
			}
			if b != t.Bin {
				it.Version = strings.TrimSpace(b + " " + it.Version)
			}
			return it
		}
	}
	it.Install = installCommand(t, managers, env.OS)
	return it
}

// installCommand picks the first way to install t that this machine has.
func installCommand(t Tool, managers []string, goos string) string {
	has := map[string]bool{}
	for _, m := range managers {
		has[m] = true
	}
	switch {
	case t.Brew != "" && has["brew"] && (goos == "darwin" || !strings.HasPrefix(t.Brew, "--cask")):
		return "brew install " + t.Brew
	case t.Apt != "" && has["apt"]:
		return "sudo apt-get install -y " + t.Apt
	case t.Pipx != "" && has["pipx"]:
		return "pipx install " + t.Pipx
	case t.Go != "" && has["go"]:
		return "go install " + t.Go
	case t.Pipx != "":
		return "pipx install " + t.Pipx + "   (install pipx first)"
	}
	return ""
}

// Plan lists the install commands for the missing tools of a report, in order.
func Plan(r Report) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, g := range r.Groups {
		for _, it := range g.Items {
			if !it.Found && it.Install != "" && !seen[it.Install] {
				seen[it.Install] = true
				out = append(out, it.Install)
			}
		}
	}
	return out
}

// Manual lists missing tools that have no install command here, with their docs.
func Manual(r Report) []Item {
	out := []Item{}
	for _, g := range r.Groups {
		for _, it := range g.Items {
			if !it.Found && it.Install == "" {
				out = append(out, it)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Required && !out[j].Required })
	return out
}

func expand(home, p string) string {
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

func firstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			if len(l) > 80 {
				l = l[:80]
			}
			return l
		}
	}
	return ""
}
