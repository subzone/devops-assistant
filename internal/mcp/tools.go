package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/subzone/devops-assistant/internal/audit"
	"github.com/subzone/devops-assistant/internal/config"
	"github.com/subzone/devops-assistant/internal/doctor"
	"github.com/subzone/devops-assistant/internal/focus"
	"github.com/subzone/devops-assistant/internal/grant"
	"github.com/subzone/devops-assistant/internal/history"
	"github.com/subzone/devops-assistant/internal/incident"
	"github.com/subzone/devops-assistant/internal/kube"
	"github.com/subzone/devops-assistant/internal/validate"
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
- Run validate_manifests on anything you generate before proposing a PR.
- rca_history says since when a problem exists and whether it happened before; fleet_status and
  security_overview are read-only overviews. incident_* tools keep incidents on this machine
  (title, severity, timeline); they never touch a cluster.
- When a command or scanner is missing, call doctor for the install command and offer it to the user;
  install only what they confirm (or point them to /devops-assistant:setup).`

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
			rep, err := d.Kube.RCA(ctx, sc)
			if err != nil {
				return nil, err
			}
			// every collection updates the history: what is new, what went away
			found := make([]history.Signal, 0, len(rep.Findings))
			for _, f := range rep.Findings {
				found = append(found, history.Signal{Namespace: f.Namespace, Object: f.Object, Signal: f.Signal, Severity: f.Severity, Detail: f.Detail})
			}
			opened, resolved, herr := history.Update(d.Home, sc.Context, sc.Namespace, found, time.Now().UTC())
			rep.Top(50)
			out := struct {
				*kube.RCAReport
				Opened   []history.Record `json:"opened"`
				Resolved []history.Record `json:"resolved"`
				History  string           `json:"history,omitempty"`
			}{RCAReport: rep, Opened: nonNil(opened), Resolved: nonNil(resolved)}
			if herr != nil {
				out.History = "not recorded: " + herr.Error()
			}
			return out, nil
		})

	s.Add(Tool{Name: "rca_history", Description: "RCA findings over time: when each problem was first and last seen, how many times it came back, and when it resolved. Open problems first. Every rca_collect records into it.",
		InputSchema: Obj(map[string]any{"context": Str("kube context (default: current; \"*\" = every context)"), "namespace": Str("namespace (empty = all)"),
			"days": Int("look back this many days, default 7, max 30"), "openOnly": Bool("only problems still open")}),
		Annotations: ro("RCA history")},
		func(ctx context.Context, a map[string]any) (any, error) {
			kc := S(a, "context")
			if kc == "*" {
				kc = ""
			} else {
				var err error
				if kc, err = d.Kube.Resolve(ctx, kc); err != nil {
					return nil, err
				}
			}
			days := I(a, "days", 7)
			if days < 1 || days > 30 {
				days = 7
			}
			return history.List(d.Home, kc, S(a, "namespace"), time.Now().Add(-time.Duration(days)*24*time.Hour), B(a, "openOnly", false))
		})

	s.Add(Tool{Name: "fleet_status", Description: "Every kube context at a glance, in parallel: reachable, nodes ready, failing and not-ready pods, warning events in the last 15 minutes, degraded/out-of-sync Argo CD apps, top problems.",
		InputSchema: Obj(map[string]any{"contexts": Str("comma-separated contexts (default: all)")}),
		Annotations: ro("Fleet status")},
		func(ctx context.Context, a map[string]any) (any, error) {
			cs := list(S(a, "contexts"))
			if len(cs) == 0 {
				all, _, err := d.Kube.Contexts(ctx)
				if err != nil {
					return nil, err
				}
				cs = all
			}
			if len(cs) > 30 {
				cs = cs[:30]
			}
			type row struct {
				kube.ClusterSummary
				Tier config.Tier `json:"tier"`
			}
			out := []row{}
			for _, s := range d.Kube.Fleet(ctx, cs, 25*time.Second) {
				out = append(out, row{s, d.Config.TierOf(s.Context)})
			}
			return out, nil
		})

	s.Add(Tool{Name: "security_overview", Description: "Read-only security posture of a cluster or namespace: privileged containers, host namespaces and hostPath, dangerous capabilities, root, privilege escalation, unpinned images, missing memory limits, writable root filesystems, cluster-admin bindings, namespaces without NetworkPolicy. Grouped by check, worst first. Not a vulnerability scan.",
		InputSchema: Obj(map[string]any{"context": ctxProp, "namespace": Str("namespace (empty = whole cluster)"), "includeSystem": Bool("include kube-system and the other system namespaces (default false)")}),
		Annotations: ro("Security overview")},
		func(ctx context.Context, a map[string]any) (any, error) {
			sc, err := scope(ctx, d, a)
			if err != nil {
				return nil, err
			}
			return d.Kube.Security(ctx, sc, B(a, "includeSystem", false))
		})

	inc := incident.Store{Home: d.Home}
	local := func(title string) Annotations { return Annotations{Title: title} }
	byProp := Str("who: claude (default), pane or monitor")

	s.Add(Tool{Name: "incident_list", Description: "Incidents kept on this machine, newest first, with their timelines.",
		InputSchema: Obj(map[string]any{"status": Str("open, mitigated, resolved, active (open or mitigated), or empty for all")}),
		Annotations: ro("List incidents")},
		func(ctx context.Context, a map[string]any) (any, error) { return inc.List(S(a, "status")) })

	s.Add(Tool{Name: "incident_open", Description: "Open an incident on this machine (a local record only; nothing changes in a cluster).",
		InputSchema: Obj(map[string]any{"title": Str("what is wrong, short"), "severity": Str("sev1 (worst) .. sev4, default sev3"), "context": Str("kube context"),
			"namespace": nsProp, "objects": Str("comma-separated objects involved, e.g. pod/api-2,deployment/api"), "note": Str("first timeline note"), "by": byProp}, "title"),
		Annotations: local("Open incident")},
		func(ctx context.Context, a map[string]any) (any, error) {
			in, err := inc.Open(S(a, "title"), S(a, "severity"), S(a, "context"), S(a, "namespace"), list(S(a, "objects")), S(a, "note"), S(a, "by"))
			if err == nil {
				audit.Write(d.Home, audit.Record{Source: "mcp", Event: "incident_open", Outcome: "opened", Detail: map[string]any{"id": in.ID, "severity": in.Severity, "context": in.Context}})
			}
			return in, err
		})

	s.Add(Tool{Name: "incident_note", Description: "Add a note to an incident's timeline.",
		InputSchema: Obj(map[string]any{"id": Str("incident id, e.g. INC-3"), "text": Str("the note"), "kind": Str("note (default) or alert"), "by": byProp}, "id", "text"),
		Annotations: local("Note on incident")},
		func(ctx context.Context, a map[string]any) (any, error) {
			return inc.Note(S(a, "id"), S(a, "text"), S(a, "by"), S(a, "kind"))
		})

	s.Add(Tool{Name: "incident_status", Description: "Move an incident to open, mitigated or resolved, with an optional note.",
		InputSchema: Obj(map[string]any{"id": Str("incident id"), "status": Str("open, mitigated or resolved"), "note": Str("why"), "by": byProp}, "id", "status"),
		Annotations: local("Incident status")},
		func(ctx context.Context, a map[string]any) (any, error) {
			in, err := inc.SetStatus(S(a, "id"), S(a, "status"), S(a, "note"), S(a, "by"))
			if err == nil {
				audit.Write(d.Home, audit.Record{Source: "mcp", Event: "incident_status", Outcome: in.Status, Detail: map[string]any{"id": in.ID}})
			}
			return in, err
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

	s.Add(Tool{Name: "doctor", Description: "Which external tools devops-assistant can use on this machine, per feature group (core, gitops, validate, iac, security, cloud, onprem, design, pane), with versions and the install command for each missing one. Looks only; installs nothing. Install only what the user picks, one command at a time, after they confirm (see /devops-assistant:setup).",
		InputSchema: Obj(map[string]any{"groups": Str("comma-separated groups, empty = all")}),
		Annotations: ro("Tool check")},
		func(ctx context.Context, a map[string]any) (any, error) {
			r := doctor.Check(ctx, doctor.DefaultEnv(), doctor.Wanted(S(a, "groups")))
			return map[string]any{"report": r, "plan": doctor.Plan(r), "manual": doctor.Manual(r)}, nil
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

func nonNil(rs []history.Record) []history.Record {
	if rs == nil {
		return []history.Record{}
	}
	return rs
}

// list splits a comma-separated argument, dropping blanks.
func list(s string) []string {
	var out []string
	for _, v := range strings.Split(s, ",") {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
