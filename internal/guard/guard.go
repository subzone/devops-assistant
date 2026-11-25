// Package guard decides whether a Claude Code tool call may run.
// It backs the PreToolUse hook. It is deliberately conservative: anything
// destructive, any secret read, and any attempt to touch the grant store is
// denied. Destructive work goes through k8sh MCP tools that require a grant.
package guard

import (
	"path/filepath"
	"regexp"
	"strings"
)

type Decision struct {
	Allow  bool
	Reason string
}

func allow() Decision        { return Decision{Allow: true} }
func deny(r string) Decision { return Decision{Allow: false, Reason: r} }

type rule struct {
	re     *regexp.Regexp
	reason string
}

// b = start-of-command boundary: beginning, whitespace, or shell separators.
const b = `(?:^|[\s;&|('"` + "`" + `$/])`

func r(p, reason string) rule { return rule{regexp.MustCompile(`(?i)` + p), reason} }

var bashRules = []rule{
	// --- destructive kubectl ---
	r(b+`kubectl\b[^;&|]*\s(delete|drain|cordon|uncordon|taint|evict)\b`, "destructive kubectl verb; use k8sh tools with a user grant"),
	r(b+`kubectl\b[^;&|]*\sscale\b[^;&|]*--replicas[= ]0\b`, "scale to 0 is destructive; use k8sh with a user grant"),
	r(b+`kubectl\b[^;&|]*\s(edit|patch|replace|set|label|annotate|rollout\s+(undo|restart)|create|expose|autoscale)\b`, "direct cluster mutation; changes go through Git -> PR -> Argo CD"),
	r(b+`kubectl\b[^;&|]*\sapply\b`, "kubectl apply mutates the cluster; changes go through Git -> PR -> Argo CD (use --dry-run=server via k8sh validate)"),
	// --- secrets ---
	r(b+`kubectl\b[^;&|]*\sget\s+(secrets?|secret/\S+)\b[^;&|]*(-o|--output)`, "reading Secret values is blocked"),
	r(b+`kubectl\b[^;&|]*\sget\b[^;&|]*\b(secrets?)\b[^;&|]*(-o|--output)`, "reading Secret values is blocked"),
	r(b+`kubectl\b[^;&|]*\s(view-secret|config\s+view\b[^;&|]*--raw)`, "reading credentials is blocked"),
	r(`\bbase64\s+(-d|--decode|-D)\b`, "base64 decoding is blocked (secret exfiltration risk)"),
	r(b+`(printenv|env)\s*($|[;&|])`, "dumping environment variables is blocked"),
	r(b+`(set|export\s+-p|declare\s+-x)\s*($|[;&|])`, "dumping environment variables is blocked"),
	// --- helm / argo / ansible ---
	r(b+`helm\b[^;&|]*\s(uninstall|delete|rollback)\b`, "destructive helm action; use k8sh with a user grant"),
	r(b+`helm\b[^;&|]*\s(install|upgrade)\b`, "helm install/upgrade mutates the cluster; deploy via GitOps"),
	r(b+`argocd\b[^;&|]*\sapp\s+(delete|terminate-op|rollback|set|patch)\b`, "destructive Argo CD action; use k8sh with a user grant"),
	r(b+`argocd\b[^;&|]*\sapp\s+sync\b[^;&|]*(--prune|--force|--replace)`, "prune/force sync is destructive; use k8sh with a user grant"),
	r(b+`ansible-playbook\b`, "ansible runs go through k8sh (check mode by default, grant for destructive plays)"),
	r(b+`ansible\b[^;&|]*\s-m\s+(shell|command|raw|file|reboot)`, "ad-hoc ansible mutation blocked"),
	// --- chaos / backup ---
	r(b+`velero\b[^;&|]*\s(delete|restore\s+create)\b`, "velero delete/restore is destructive; use k8sh with a user grant"),
	// --- cloud cluster destruction ---
	r(b+`eksctl\b[^;&|]*\sdelete\b`, "cluster deletion blocked"),
	r(b+`aws\s+eks\s+(delete|update-cluster-version|update-nodegroup-version)`, "EKS delete/upgrade requires a user grant via k8sh"),
	r(b+`az\s+aks\s+(delete|upgrade|nodepool\s+(delete|upgrade)|stop)\b`, "AKS delete/upgrade requires a user grant via k8sh"),
	r(b+`gcloud\s+container\s+(clusters|node-pools)\s+(delete|upgrade)\b`, "GKE delete/upgrade requires a user grant via k8sh"),
	r(b+`terraform\b[^;&|]*\s(destroy|apply)\b`, "terraform apply/destroy blocked from the agent"),
	// --- git history ---
	r(b+`git\b[^;&|]*\spush\b[^;&|]*(\s-f\b|--force|--mirror|--delete|\s:\S)`, "force-push / remote deletion blocked"),
	r(b+`git\b[^;&|]*\s(filter-branch|filter-repo)\b`, "history rewrite blocked"),
	// --- grant store / lock bypass ---
	r(b+`k8sh(-launch)?\b[^;&|]*\s(unlock|grant)\b`, "unlocking is user-only: run it yourself in a separate terminal"),
	r(`\.k8sh/`, "the k8sh state directory (grants, audit log) is off-limits"),
	r(b+`(script|expect|unbuffer|socat)\b`, "pseudo-terminal tools are blocked (lock bypass risk)"),
	r(`\bpty\.spawn\b|\bpexpect\b|\bopenpty\b`, "pseudo-terminal spawning is blocked (lock bypass risk)"),
	r(b+`tmux\b[^;&|]*\s(send-keys|send|paste-buffer|set-buffer|load-buffer|pipe-pane)\b`, "typing into terminal panes is blocked (lock bypass risk)"),
	r(b+`(wezterm\s+cli\s+send-text|kitty\s+@\s*send-text|xdotool|ydotool|wtype)\b`, "synthetic keystrokes are blocked (lock bypass risk)"),
	r(b+`osascript\b[^;&|]*(keystroke|key code|System Events|write text)`, "synthetic keystrokes are blocked (lock bypass risk)"),
	r(`\bCLAUDECODE\b`, "tampering with the agent marker is blocked"),
}

// credential locations. Matched against commands and file paths.
var credPaths = []string{
	".kube/", ".kube\\", ".aws/", ".azure/", ".config/gcloud", ".docker/config.json",
	".ssh/", ".gnupg/", ".netrc", ".git-credentials", ".vault-token", ".k8sh/",
}

var credFileRe = regexp.MustCompile(`(?i)(^|/)(\.env(\.[a-z0-9_-]+)?|kubeconfig[^/]*|credentials(\.json)?|.*\.(pem|key|p12|pfx|jks|kdbx))$`)

func isCredPath(p string) bool {
	p = filepath.ToSlash(p)
	lp := strings.ToLower(p)
	for _, c := range credPaths {
		if strings.Contains(lp, strings.ToLower(filepath.ToSlash(c))) {
			return true
		}
	}
	base := filepath.Base(lp)
	if base == ".env.example" || base == ".env.sample" || strings.HasSuffix(base, ".pub") {
		return false
	}
	return credFileRe.MatchString(lp)
}

var readCmd = regexp.MustCompile(`(?i)` + b + `(cat|less|more|head|tail|bat|xxd|od|strings|grep|rg|awk|sed|cp|scp|rsync|tar|zip|curl|nc|python3?|node|ruby|perl|jq|yq|vi|vim|nano|open|source|\.)\s`)

// Bash evaluates a shell command string.
func Bash(cmd string) Decision {
	norm := strings.ReplaceAll(cmd, "\\\n", " ")
	for _, rl := range bashRules {
		if rl.re.MatchString(norm) {
			return deny(rl.reason)
		}
	}
	if readCmd.MatchString(norm) || strings.Contains(norm, "KUBECONFIG") {
		for _, f := range strings.Fields(norm) {
			f = strings.Trim(f, `"'<>;|&()`)
			if isCredPath(f) {
				return deny("access to credential file " + f + " is blocked")
			}
		}
	}
	return allow()
}

// Path evaluates Read/Write/Edit/Grep/Glob targets.
func Path(tool, p string) Decision {
	if p == "" {
		return allow()
	}
	if isCredPath(p) {
		return deny(tool + " on credential path " + p + " is blocked")
	}
	return allow()
}

// Evaluate dispatches by Claude Code tool name and tool_input.
func Evaluate(tool string, input map[string]any) Decision {
	str := func(k string) string { s, _ := input[k].(string); return s }
	switch tool {
	case "Bash":
		return Bash(str("command"))
	case "Read", "Write", "Edit", "MultiEdit", "NotebookEdit":
		p := str("file_path")
		if p == "" {
			p = str("notebook_path")
		}
		if d := Path(tool, p); !d.Allow {
			return d
		}
		if tool != "Read" {
			c := str("content") + str("new_string")
			if looksLikePlainSecretManifest(c) {
				return deny("writing a Kubernetes Secret with data is blocked; use an ExternalSecret")
			}
		}
		return allow()
	case "Grep", "Glob":
		return Path(tool, str("path"))
	}
	return allow()
}

var secretKindRe = regexp.MustCompile(`(?m)^\s*kind:\s*Secret\s*$`)
var secretDataRe = regexp.MustCompile(`(?m)^\s*(data|stringData):\s*$`)

func looksLikePlainSecretManifest(s string) bool {
	if s == "" {
		return false
	}
	for _, doc := range regexp.MustCompile(`(?m)^---\s*$`).Split(s, -1) {
		if secretKindRe.MatchString(doc) && secretDataRe.MatchString(doc) {
			return true
		}
	}
	return false
}
