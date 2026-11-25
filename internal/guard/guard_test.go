package guard

import "testing"

func TestBashDenied(t *testing.T) {
	denied := []string{
		"kubectl delete pod x -n a",
		"kubectl --context eks-prod -n pay delete deploy api",
		"kubectl drain node-1",
		"kubectl scale deploy api --replicas=0",
		"kubectl apply -f x.yaml",
		"kubectl patch deploy api -p '{}'",
		"kubectl get secret db -o yaml",
		"kubectl get secrets -n a -o json",
		"kubectl -n a get secret/db -o jsonpath='{.data}'",
		"kubectl config view --raw",
		"echo aGk= | base64 -d",
		"printenv",
		"env | grep TOKEN",
		"helm uninstall api",
		"helm upgrade --install api ./chart",
		"argocd app delete api",
		"argocd app sync api --prune",
		"ansible-playbook site.yml",
		"git push --force origin main",
		"git push origin :main",
		"k8sh unlock eks-prod delete pod/x",
		"bin/k8sh-launch unlock dev delete x",
		"cat ~/.kube/config",
		"cat /home/u/.aws/credentials",
		"echo hi > ~/.k8sh/grants/x.json",
		"script -q /dev/null k8sh unlock",
		"ls && kubectl delete ns x",
		"bash -c 'kubectl delete ns x'",
		"az aks delete -n c -g r",
		"terraform destroy",
		"cat .env",
		"cat ~/.k8sh/config.json",
		"tmux send-keys -t 1 k3d-mycluster Enter",
		"wezterm cli send-text k3d",
		`osascript -e 'tell application "System Events" to keystroke "x"'`,
		"xdotool type k3d",
		"k8sh grant x",
	}
	for _, c := range denied {
		if d := Bash(c); d.Allow {
			t.Errorf("expected deny: %q", c)
		}
	}
}

func TestBashAllowed(t *testing.T) {
	allowed := []string{
		"kubectl get pods -A",
		"kubectl get deploy -n a -o yaml",
		"kubectl describe secret db",
		"kubectl get secrets -n a",
		"kubectl logs api-123 -n a --tail 100",
		"helm template ./chart",
		"helm lint ./chart",
		"kustomize build overlays/dev",
		"argocd app get api",
		"git push origin feature/x",
		"git status",
		"go test ./...",
		"cat README.md",
		"cat .env.example",
		"k8sh status",
		"/home/u/.claude/plugins/marketplaces/subzone/bin/k8sh-launch config set-tier k3d-mycluster dev",
		"k8sh config show",
		"k8sh tui --open",
		"tmux split-window -h k8sh tui",
		"k8sh settings apply --statusline 'k8sh statusline'",
	}
	for _, c := range allowed {
		if d := Bash(c); !d.Allow {
			t.Errorf("expected allow: %q (%s)", c, d.Reason)
		}
	}
}

func TestPaths(t *testing.T) {
	if Evaluate("Read", map[string]any{"file_path": "/home/u/.kube/config"}).Allow {
		t.Error("kubeconfig read allowed")
	}
	if Evaluate("Read", map[string]any{"file_path": "/repo/.env"}).Allow {
		t.Error(".env read allowed")
	}
	if !Evaluate("Read", map[string]any{"file_path": "/repo/main.go"}).Allow {
		t.Error("normal read denied")
	}
	if Evaluate("Write", map[string]any{"file_path": "/repo/s.yaml", "content": "apiVersion: v1\nkind: Secret\nmetadata:\n  name: x\ndata:\n  pw: aGk=\n"}).Allow {
		t.Error("plain secret write allowed")
	}
	if !Evaluate("Write", map[string]any{"file_path": "/repo/es.yaml", "content": "kind: ExternalSecret\nspec:\n  data:\n  - secretKey: pw\n"}).Allow {
		t.Error("ExternalSecret write denied")
	}
}
