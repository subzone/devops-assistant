package kube

import (
	"context"
	"encoding/json"
)

type ArgoApp struct {
	Name        string `json:"name"`
	Project     string `json:"project"`
	Sync        string `json:"sync"`
	Health      string `json:"health"`
	Revision    string `json:"revision,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Path        string `json:"path,omitempty"`
	DestServer  string `json:"destServer,omitempty"`
	DestNS      string `json:"destNamespace,omitempty"`
	AutoSync    bool   `json:"autoSync"`
	AutoPrune   bool   `json:"autoPrune"`
	OperationOK string `json:"lastOperation,omitempty"`
}

type ArgoResource struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Status    string `json:"sync"`
	Health    string `json:"health,omitempty"`
	Message   string `json:"message,omitempty"`
}

type argoApp struct {
	Metadata struct{ Name string } `json:"metadata"`
	Spec     struct {
		Project string `json:"project"`
		Source  struct {
			RepoURL, Path, TargetRevision string
		} `json:"source"`
		Destination struct{ Server, Namespace, Name string } `json:"destination"`
		SyncPolicy  struct {
			Automated *struct{ Prune bool } `json:"automated"`
		} `json:"syncPolicy"`
	} `json:"spec"`
	Status struct {
		Sync struct {
			Status, Revision string
		} `json:"sync"`
		Health struct {
			Status, Message string
		} `json:"health"`
		OperationState struct{ Phase string } `json:"operationState"`
		Resources      []struct {
			Kind, Name, Namespace, Status string
			Health                        *struct{ Status, Message string }
		} `json:"resources"`
	} `json:"status"`
}

func summarize(a argoApp) ArgoApp {
	out := ArgoApp{
		Name: a.Metadata.Name, Project: a.Spec.Project, Sync: a.Status.Sync.Status,
		Health: a.Status.Health.Status, Revision: a.Status.Sync.Revision,
		Repo: a.Spec.Source.RepoURL, Path: a.Spec.Source.Path,
		DestServer: a.Spec.Destination.Server, DestNS: a.Spec.Destination.Namespace,
		OperationOK: a.Status.OperationState.Phase,
	}
	if a.Spec.SyncPolicy.Automated != nil {
		out.AutoSync = true
		out.AutoPrune = a.Spec.SyncPolicy.Automated.Prune
	}
	return out
}

func (c *Client) ArgoApps(ctx context.Context, s Scope) ([]ArgoApp, error) {
	if s.Namespace == "" {
		s.Namespace = "argocd"
	}
	b, err := c.GetJSON(ctx, s, "applications.argoproj.io", "", "", false)
	if err != nil {
		return nil, err
	}
	var l struct{ Items []argoApp }
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, err
	}
	out := make([]ArgoApp, 0, len(l.Items))
	for _, it := range l.Items {
		out = append(out, summarize(it))
	}
	return out, nil
}

func (c *Client) ArgoAppTree(ctx context.Context, s Scope, name string) (ArgoApp, []ArgoResource, error) {
	if s.Namespace == "" {
		s.Namespace = "argocd"
	}
	b, err := c.GetJSON(ctx, s, "applications.argoproj.io", name, "", false)
	if err != nil {
		return ArgoApp{}, nil, err
	}
	var a argoApp
	if err := json.Unmarshal(b, &a); err != nil {
		return ArgoApp{}, nil, err
	}
	var res []ArgoResource
	for _, r := range a.Status.Resources {
		ar := ArgoResource{Kind: r.Kind, Name: r.Name, Namespace: r.Namespace, Status: r.Status}
		if r.Health != nil {
			ar.Health, ar.Message = r.Health.Status, r.Health.Message
		}
		res = append(res, ar)
	}
	return summarize(a), res, nil
}
