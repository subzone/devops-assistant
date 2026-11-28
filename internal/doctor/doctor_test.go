package doctor

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func fakeEnv(goos string, bins []string, files []string) Env {
	have := map[string]bool{}
	for _, b := range bins {
		have[b] = true
	}
	fs := map[string]bool{}
	for _, f := range files {
		fs[f] = true
	}
	return Env{
		Home: "/h",
		OS:   goos,
		LookPath: func(n string) (string, error) {
			if have[n] {
				return "/bin/" + n, nil
			}
			return "", exec.ErrNotFound
		},
		Exists: func(p string) bool { return fs[p] },
		Run: func(_ context.Context, bin string, args ...string) string {
			return "\n  " + strings.TrimPrefix(bin, "/bin/") + " v1.2.3\nmore\n"
		},
	}
}

func find(r Report, name string) (Item, bool) {
	for _, g := range r.Groups {
		for _, it := range g.Items {
			if it.Name == name {
				return it, true
			}
		}
	}
	return Item{}, false
}

func TestCheckFoundMissingAndRequired(t *testing.T) {
	r := Check(context.Background(), fakeEnv("darwin", []string{"brew", "git", "helm", "tofu"}, []string{"/h/.local/share/whisper-models/ggml-base.en.bin"}), nil)
	if len(r.RequiredMissing) != 1 || r.RequiredMissing[0] != "kubectl" {
		t.Fatalf("required missing = %v", r.RequiredMissing)
	}
	if it, _ := find(r, "helm"); !it.Found || it.Version != "helm v1.2.3" || it.Path != "/bin/helm" {
		t.Errorf("helm = %+v", it)
	}
	if it, _ := find(r, "terraform"); !it.Found || !strings.HasPrefix(it.Version, "tofu ") {
		t.Errorf("tofu should satisfy terraform: %+v", it)
	}
	if it, _ := find(r, "kubectl"); it.Found || it.Install != "brew install kubectl" {
		t.Errorf("kubectl = %+v", it)
	}
	if it, _ := find(r, "az"); it.Install != "brew install --cask azure-cli" {
		t.Errorf("az = %+v", it)
	}
	if it, _ := find(r, "whisper model"); !it.Found {
		t.Errorf("model file should be found: %+v", it)
	}
	if it, _ := find(r, "piper voice"); it.Found || !strings.Contains(it.Install, "download_voices") {
		t.Errorf("piper voice = %+v", it)
	}
	if len(r.Groups) != len(Groups) {
		t.Errorf("groups = %d", len(r.Groups))
	}
}

func TestInstallFallbacksOnLinux(t *testing.T) {
	r := Check(context.Background(), fakeEnv("linux", []string{"apt-get", "go"}, nil), Wanted("core,iac,cloud,onprem"))
	for name, want := range map[string]string{
		"git":     "sudo apt-get install -y git",
		"tflint":  "go install github.com/terraform-linters/tflint@latest",
		"ansible": "sudo apt-get install -y ansible",
		"kubectl": "", // no brew, no apt package: manual, with docs
		"az":      "", // a cask: not on Linux
	} {
		it, ok := find(r, name)
		if !ok || it.Install != want {
			t.Errorf("%s install = %q, want %q", name, it.Install, want)
		}
	}
	if len(r.Groups) != 4 {
		t.Errorf("only the wanted groups: %d", len(r.Groups))
	}
	man := Manual(r)
	if len(man) == 0 || man[0].Name != "kubectl" || man[0].Docs == "" {
		t.Errorf("manual list should start with required kubectl and give docs: %+v", man)
	}
	plan := Plan(r)
	for _, c := range plan {
		if c == "" {
			t.Fatal("empty command in plan")
		}
	}
	if len(plan) == 0 {
		t.Fatal("plan should not be empty")
	}
}

func TestWanted(t *testing.T) {
	if len(Wanted("")) != 0 || len(Wanted("all")) != 0 {
		t.Error("empty and all mean every group")
	}
	if w := Wanted(" Cloud, onprem "); !w["cloud"] || !w["onprem"] || len(w) != 2 {
		t.Errorf("wanted = %v", w)
	}
}

func TestEveryToolHasAGroupAndAWayIn(t *testing.T) {
	ids := map[string]bool{}
	for _, g := range Groups {
		ids[g.ID] = true
	}
	for _, tl := range Tools {
		if !ids[tl.Group] {
			t.Errorf("%s: unknown group %q", tl.Name, tl.Group)
		}
		if tl.URL == "" && tl.Get == "" {
			t.Errorf("%s: needs docs or a get command", tl.Name)
		}
		if (tl.Bin == "") == (tl.File == "") {
			t.Errorf("%s: exactly one of Bin or File", tl.Name)
		}
	}
}
