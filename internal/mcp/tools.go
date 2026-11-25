package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/subzone/k8s-handler/internal/audit"
	"github.com/subzone/k8s-handler/internal/config"
	"github.com/subzone/k8s-handler/internal/focus"
	"github.com/subzone/k8s-handler/internal/grant"
	"github.com/subzone/k8s-handler/internal/kube"
	"github.com/subzone/k8s-handler/internal/validate"
)

type Deps struct {
	Home   string
	Kube   *kube.Client
	Grants *grant.Store
	Config *config.Config
}

const instructions = `k8sh: GitOps-first Kubernetes operations with a hard safety lock.
Rules you must follow:
- Read tools are safe. Changes go through Git -> PR -> Argo CD; never mutate clusters directly.
- destructive_* tools are LOCKED. They only work if the USER has issued a grant in their own terminal
  ("k8sh unlock ..."). You cannot create grants. If a tool says LOCKED, show the user the exact
  unlock command it returns and stop. Never try to work around the lock.
- Secret values are always redacted. Never ask for, print, or store credentials. Generate ExternalSecret, never Secret with data.
- Run validate_manifests on anything you generate before proposing a PR.`

func scope(ctx context.Context, d Deps, a map[string]any) (kube.Scope, error) {
	c, err := d.Kube.Resolve(ctx, S(a, "context"))
	return kube.Scope{Context: c, Namespace: S(a, "namespace")}, err
}

var ctxProp = Str("kube context (default: current context)")
var nsProp = Str("namespace")

func Register(s *Server, d Deps) {
	s.Instructions = instructions
	ro := func(title string) Annotations {
		return Annotations{Title: title, ReadOnlyHint: true, IdempotentHint: true}
	}

	s.Add(Tool{Name: "k8s_contexts", Description: "List kube contexts with their k8sh tier (dev/staging/prod; unknown = prod) and the current context.", Annotations: ro("List contexts")},
		func(ctx context.Context, a map[string]any) (any, error) {
			cs, cur, err := d.Kube.Contexts(ctx)
			if err != nil {
				return nil, err
			}
			type row struct {
				Name    string      `json:"name"`
				Tier    config.Tier `json:"tier"`
				Current bool        `json:"current"`
			}
			out := []row{}
			for _, c := range cs {
				out = append(out, row{c, d.Config.TierOf(c), c == cur})
			}
			return out, nil
		})

	s.Add(Tool{Name: "k8s_get", Description: "Get resources as JSON (secrets are redacted to keys only).",
		InputSchema: Obj(map[string]any{"kind": Str("resource kind, e.g. pods, deploy, applications.argoproj.io"), "name": Str("optional name"),
			"namespace": nsProp, "context": ctxProp, "selector": Str("label selector"), "allNamespaces": Bool("all namespaces")}, "kind"),
		Annotations: ro("Get resources")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			b, err := d.Kube.GetJSON(ctx, sc, S(a, "kind"), S(a, "name"), S(a, "selector"), B(a, "allNamespaces", false))
			return string(b), err
		})

	s.Add(Tool{Name: "k8s_describe", Description: "kubectl describe (output redacted).",
		InputSchema: Obj(map[string]any{"kind": Str("kind"), "name": Str("name"), "namespace": nsProp, "context": ctxProp}, "kind"),
		Annotations: ro("Describe")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.Describe(ctx, sc, S(a, "kind"), S(a, "name"))
		})

	s.Add(Tool{Name: "k8s_events", Description: "Recent events, newest first (warnings only by default).",
		InputSchema: Obj(map[string]any{"namespace": Str("namespace (empty = all)"), "context": ctxProp, "warningsOnly": Bool("default true")}),
		Annotations: ro("Events")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.Events(ctx, sc, B(a, "warningsOnly", true))
		})

	s.Add(Tool{Name: "k8s_logs", Description: "Pod logs (max 500 lines, credentials redacted).",
		InputSchema: Obj(map[string]any{"pod": Str("pod name"), "container": Str("container"), "namespace": nsProp, "context": ctxProp,
			"tail": Int("lines, default 200, max 500"), "previous": Bool("previous container instance")}, "pod"),
		Annotations: ro("Logs")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.Logs(ctx, sc, S(a, "pod"), S(a, "container"), I(a, "tail", 200), B(a, "previous", false))
		})

	s.Add(Tool{Name: "argo_apps", Description: "Argo CD applications with sync/health, source and auto-sync/prune flags.",
		InputSchema: Obj(map[string]any{"context": ctxProp, "namespace": Str("Argo CD namespace (default argocd)")}),
		Annotations: ro("Argo CD apps")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.ArgoApps(ctx, sc)
		})

	s.Add(Tool{Name: "argo_app_tree", Description: "Resource tree of one Argo CD application with per-resource sync and health.",
		InputSchema: Obj(map[string]any{"name": Str("application name"), "context": ctxProp, "namespace": Str("Argo CD namespace (default argocd)")}, "name"),
		Annotations: ro("Argo CD app tree")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			app, res, err := d.Kube.ArgoAppTree(ctx, sc, S(a, "name"))
			return map[string]any{"app": app, "resources": res}, err
		})

	s.Add(Tool{Name: "rca_collect", Description: "Collect ranked RCA signals for a namespace: CrashLoopBackOff, OOMKilled, image pull errors, pending pods, restarts, readiness, recent warnings.",
		InputSchema: Obj(map[string]any{"namespace": Str("namespace (empty = all)"), "context": ctxProp}),
		Annotations: ro("RCA signals")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.RCA(ctx, sc)
		})

	s.Add(Tool{Name: "validate_manifests", Description: "Run the validation pipeline on a file or directory. Kubernetes (kustomize/helm/plain, incl. Crossplane): render, secret scan, schema, lint, policy, security, crossplane validate, optional server dry-run. Terraform/OpenTofu dirs: secret scan, fmt, init -backend=false + validate, tflint, trivy, checkov, infracost estimate. Must pass before proposing a PR.",
		InputSchema: Obj(map[string]any{"path": Str("file or directory"), "context": Str("if set, also run kubectl apply --dry-run=server against this context"),
			"strict": Bool("fail when scanners are missing (default false; CI should use true)")}, "path"),
		Annotations: ro("Validate manifests")},
		func(ctx context.Context, a map[string]any) (any, error) {
			o := validate.Options{Strict: B(a, "strict", false)}
			if c := S(a, "context"); c != "" {
				o.DryRun = func(ctx context.Context, f string) (string, error) { return d.Kube.DryRunServer(ctx, c, f) }
			}
			return validate.Run(ctx, S(a, "path"), o)
		})

	s.Add(Tool{Name: "lock_status", Description: "Show the destructive-action lock: active user grants (scope + expiry). Grants can only be created by the user.", Annotations: ro("Lock status")},
		func(ctx context.Context, a map[string]any) (any, error) {
			gs, err := d.Grants.List()
			if err != nil {
				return nil, err
			}
			type g struct {
				Context, Namespace, Action, Target string
				ExpiresIn                          string
			}
			out := []g{}
			for _, x := range gs {
				out = append(out, g{x.Context, x.Namespace, x.Action, x.Target, time.Until(x.ExpiresAt).Round(time.Second).String()})
			}
			state := "LOCKED"
			if len(out) > 0 {
				state = "LOCKED (with single-use grants)"
			}
			return map[string]any{"state": state, "grants": out}, nil
		})

	s.Add(Tool{Name: "tui_focus", Description: "Read what the user selected in the k8sh TUI (they pressed f): context, tier, view, kind, name, status and detail (events/logs if shown). Redacted.", Annotations: ro("TUI selection")},
		func(ctx context.Context, a map[string]any) (any, error) {
			f, err := focus.Read(d.Home)
			if err != nil {
				return nil, errors.New("nothing selected yet: in the TUI select an item and press f")
			}
			age := time.Since(f.Time).Round(time.Second)
			return map[string]any{"focus": f, "age": age.String()}, nil
		})

	destructive := func(name, action, desc string, run func(context.Context, kube.Scope, string) (string, error)) {
		s.Add(Tool{Name: name, Description: desc + " LOCKED: requires a single-use grant the user issued in their own terminal; otherwise returns the unlock command to show the user.",
			InputSchema: Obj(map[string]any{"context": Str("kube context (required, explicit)"), "namespace": nsProp, "target": Str("kind/name")}, "context", "namespace", "target"),
			Annotations: Annotations{Title: name, DestructiveHint: true}},
			func(ctx context.Context, a map[string]any) (any, error) {
				c, ns, target := S(a, "context"), S(a, "namespace"), S(a, "target")
				if c == "" || target == "" {
					return nil, errors.New("context and target are required for destructive tools")
				}
				detail := map[string]any{"context": c, "namespace": ns, "target": target, "tier": d.Config.TierOf(c)}
				g, err := d.Grants.Consume(c, ns, action, target)
				if err != nil {
					audit.Write(d.Home, audit.Record{Source: "mcp", Event: name, Outcome: "blocked-locked", Detail: detail})
					return nil, err
				}
				detail["grant"] = g.ID
				out, err := run(ctx, kube.Scope{Context: c, Namespace: ns}, target)
				outcome := "executed"
				if err != nil {
					outcome = "failed"
				}
				audit.Write(d.Home, audit.Record{Source: "mcp", Event: name, Outcome: outcome, Detail: detail})
				if err != nil {
					return nil, err
				}
				b, _ := json.Marshal(map[string]any{"result": out, "grantConsumed": g.ID})
				return string(b), nil
			})
	}
	destructive("destructive_delete", "delete", "Delete one resource (kind/name).", d.Kube.Delete)
	destructive("destructive_scale_zero", "scale-zero", "Scale one workload to 0 replicas.", d.Kube.ScaleZero)
}
