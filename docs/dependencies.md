# Dependencies

devops-assistant needs only **`kubectl`** and **`git`** to start. Every other tool switches on a feature, and each feature degrades gracefully: a validation stage without its tool is marked *skipped*, an analysis without a scanner uses quick checks, Steve without Piper uses the macOS voices.

## Check what you have
```bash
k8sh doctor                     # every group
k8sh doctor --group cloud,iac   # some groups
k8sh doctor --plan --group security,design   # only the install commands for what's missing
k8sh doctor --json
```
Claude reads the same report with the `doctor` MCP tool. `doctor` only looks (PATH plus the usual Homebrew, `~/.local/bin` and `~/go/bin` places, and each tool's version flag); it never installs anything. It exits 1 when a required tool is missing.

## Install what you pick
`/devops-assistant:setup` asks which groups you want, shows the plan and runs it one command at a time after you confirm. It picks the first way your machine has: Homebrew (casks only on macOS), apt (with `sudo`: you run those lines), pipx, `go install`; otherwise it links the official docs instead of improvising a `curl | sh`. It never upgrades or removes other software.

## Tools by group

| Group | Tool | Needed for | Homebrew |
|---|---|---|---|
| **core** | kubectl (**required**) | every cluster read | `kubectl` |
| | git (**required**) | GitOps changes and PRs | `git` |
| | go | building k8sh from source when no release binary is available | `go` |
| **gitops** | helm | rendering and linting charts | `helm` |
| | kustomize | building overlays (`kubectl kustomize` works too) | `kustomize` |
| | argocd | Argo CD CLI reads (the MCP tools use kubectl) | `argocd` |
| **validate** | kubeconform | schema validation | `kubeconform` |
| | kube-linter | best-practice lint | `kube-linter` |
| | gitleaks | secret scan (a builtin scan runs either way) | `gitleaks` |
| | trivy | misconfiguration scan for manifests and Terraform | `trivy` |
| | kyverno | policy checks when the repo has `policies/` | `kyverno` |
| **iac** | terraform or tofu | fmt / validate | `hashicorp/tap/terraform` or `opentofu` |
| | tflint | Terraform lint | — (`go install github.com/terraform-linters/tflint@latest`) |
| | checkov | Terraform security scan | `checkov` (or pipx) |
| | infracost | cost estimate before deploy (free API key in your env) | `infracost` |
| | crossplane | `crossplane beta validate` | `crossplane` |
| **security** | prowler | cloud and Kubernetes posture scan | `prowler` (or pipx) |
| | kubescape | Kubernetes posture frameworks | `kubescape` |
| **cloud** | aws · az · gcloud · hcloud · doctl · aliyun | costs, logs, inventory and security per cloud: install the ones you use | `awscli` · cask `azure-cli` · cask `gcloud-cli` · `hcloud` · `doctl` · `aliyun-cli` |
| **onprem** | govc | VMware vSphere | `govc` |
| | ansible | bare-metal facts | `ansible` (or pipx, apt) |
| **design** | mmdc · d2 | SVGs of design diagrams (Mermaid renders on GitHub without them) | `mermaid-cli` · `d2` |
| **pane** | tmux | `k8sh workspace`, `tui --open` | `tmux` |
| | piper + the Ryan voice | Steve's neural voice | pipx `piper-tts`, then `python -m piper.download_voices … en_US-ryan-medium` |
| | ffmpeg · whisper-cli + model | 🎤 talk (recording and on-device transcription, ~150 MB model) | `ffmpeg` · `whisper-cpp` |

Cloud CLIs use your own logins (`aws sso login`, `az login`, `gcloud auth login`, …), which you run yourself. Claude never asks for or reads keys.

The table mirrors `internal/doctor/doctor.go`, which is the source of truth.
