// Package kube wraps kubectl. Using kubectl (instead of client-go) keeps the
// user's auth exec plugins (aws eks get-token, kubelogin, gke-gcloud-auth-
// plugin, OIDC) working and keeps k8sh dependency-free.
package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/subzone/devops-assistant/internal/redact"
)

// Exec runs a binary and returns stdout. Replaceable in tests.
type Exec func(ctx context.Context, name string, args ...string) ([]byte, error)

func DefaultExec(ctx context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	if err != nil {
		return out.Bytes(), fmt.Errorf("%s: %v: %s", name, err, redact.Text(strings.TrimSpace(errb.String())))
	}
	return out.Bytes(), nil
}

type Client struct {
	Exec    Exec
	Kubectl string
	// Now is the clock that ages past problems; time.Now when nil.
	Now func() time.Time
}

func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}

func New() *Client { return &Client{Exec: DefaultExec, Kubectl: "kubectl"} }

var safeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,252}$`)
var safeKind = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.,/-]{0,252}$`)
var safeSelector = regexp.MustCompile(`^[A-Za-z0-9._/=!,() -]{1,512}$`)

func check(field, v string) error {
	if v == "" {
		return nil
	}
	if !safeName.MatchString(v) {
		return fmt.Errorf("invalid %s %q", field, v)
	}
	return nil
}

func (c *Client) run(ctx context.Context, args ...string) ([]byte, error) {
	return c.Exec(ctx, c.Kubectl, args...)
}

// CurrentContext resolves the active context.
func (c *Client) CurrentContext(ctx context.Context) (string, error) {
	b, err := c.run(ctx, "config", "current-context")
	return strings.TrimSpace(string(b)), err
}

// Resolve returns kubeCtx or the current context.
func (c *Client) Resolve(ctx context.Context, kubeCtx string) (string, error) {
	if kubeCtx != "" {
		return kubeCtx, check("context", kubeCtx)
	}
	cur, err := c.CurrentContext(ctx)
	if err != nil || cur == "" {
		return "", errors.New("no kube context given and no current context set")
	}
	return cur, nil
}

func (c *Client) Contexts(ctx context.Context) ([]string, string, error) {
	b, err := c.run(ctx, "config", "get-contexts", "-o", "name")
	if err != nil {
		return nil, "", err
	}
	cur, _ := c.CurrentContext(ctx)
	var out []string
	for _, l := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if l != "" {
			out = append(out, l)
		}
	}
	return out, cur, nil
}

type Scope struct {
	Context   string `json:"context,omitempty"`
	Namespace string `json:"namespace,omitempty"`
}

func (s Scope) args(allNS bool) ([]string, error) {
	if err := check("context", s.Context); err != nil {
		return nil, err
	}
	if err := check("namespace", s.Namespace); err != nil {
		return nil, err
	}
	// --context and -n are global flags and may lead; --all-namespaces is the
	// verb's own and must follow it (kubectl 1.37 refuses it in front, as a
	// plugin lookup), so GetJSON adds it after "get".
	a := []string{"--context", s.Context}
	if !allNS && s.Namespace != "" {
		a = append(a, "-n", s.Namespace)
	}
	return a, nil
}

func (c *Client) GetJSON(ctx context.Context, s Scope, kind, name, selector string, allNS bool) ([]byte, error) {
	if !safeKind.MatchString(kind) {
		return nil, fmt.Errorf("invalid kind %q", kind)
	}
	if err := check("name", name); err != nil {
		return nil, err
	}
	a, err := s.args(allNS)
	if err != nil {
		return nil, err
	}
	a = append(a, "get", kind)
	if allNS {
		a = append(a, "--all-namespaces")
	}
	if name != "" {
		a = append(a, name)
	}
	if selector != "" {
		if !safeSelector.MatchString(selector) {
			return nil, fmt.Errorf("invalid selector")
		}
		a = append(a, "-l", selector)
	}
	a = append(a, "-o", "json")
	b, err := c.run(ctx, a...)
	if err != nil {
		return nil, err
	}
	return redact.JSON(b), nil
}

func (c *Client) Describe(ctx context.Context, s Scope, kind, name string) (string, error) {
	if err := check("kind", kind); err != nil || kind == "" {
		return "", fmt.Errorf("invalid kind")
	}
	if err := check("name", name); err != nil {
		return "", err
	}
	a, err := s.args(false)
	if err != nil {
		return "", err
	}
	a = append(a, "describe", kind)
	if name != "" {
		a = append(a, name)
	}
	b, err := c.run(ctx, a...)
	return redact.Text(string(b)), err
}

func (c *Client) Logs(ctx context.Context, s Scope, pod, container string, tail int, previous bool) (string, error) {
	if pod == "" {
		return "", errors.New("pod is required")
	}
	if err := check("pod", pod); err != nil {
		return "", err
	}
	if err := check("container", container); err != nil {
		return "", err
	}
	if tail <= 0 || tail > 500 {
		tail = 200
	}
	a, err := s.args(false)
	if err != nil {
		return "", err
	}
	a = append(a, "logs", pod, fmt.Sprintf("--tail=%d", tail))
	if container != "" {
		a = append(a, "-c", container)
	}
	if previous {
		a = append(a, "--previous")
	}
	b, err := c.run(ctx, a...)
	return redact.Text(string(b)), err
}

type Event struct {
	Type    string `json:"type"`
	Reason  string `json:"reason"`
	Object  string `json:"object"`
	Message string `json:"message"`
	Count   int    `json:"count"`
	Last    string `json:"last"`
}

func (c *Client) Events(ctx context.Context, s Scope, warningsOnly bool) ([]Event, error) {
	b, err := c.GetJSON(ctx, s, "events", "", "", s.Namespace == "")
	if err != nil {
		return nil, err
	}
	var l struct {
		Items []struct {
			Type, Reason, Message string
			Count                 int
			LastTimestamp         string
			EventTime             string
			Metadata              struct{ CreationTimestamp string } `json:"metadata"`
			InvolvedObject        struct{ Kind, Name, Namespace string }
		}
	}
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, err
	}
	var out []Event
	for _, it := range l.Items {
		if warningsOnly && it.Type != "Warning" {
			continue
		}
		last := it.LastTimestamp
		if last == "" {
			last = it.EventTime
		}
		if last == "" {
			last = it.Metadata.CreationTimestamp
		}
		obj := it.InvolvedObject.Kind + "/" + it.InvolvedObject.Name
		if it.InvolvedObject.Namespace != "" {
			obj = it.InvolvedObject.Namespace + "/" + obj
		}
		out = append(out, Event{it.Type, it.Reason, obj, it.Message, it.Count, last})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Last > out[j].Last })
	if len(out) > 100 {
		out = out[:100]
	}
	return out, nil
}

// DryRunServer validates a file against the live API server without
// persisting anything.
func (c *Client) DryRunServer(ctx context.Context, kubeCtx, file string) (string, error) {
	if err := check("context", kubeCtx); err != nil {
		return "", err
	}
	if strings.HasPrefix(file, "-") {
		return "", errors.New("invalid file")
	}
	b, err := c.run(ctx, "--context", kubeCtx, "apply", "--dry-run=server", "-f", file)
	return redact.Text(string(b)), err
}

// --- destructive operations: callers MUST hold a consumed grant ---

func (c *Client) Delete(ctx context.Context, s Scope, kindName string) (string, error) {
	if err := check("target", kindName); err != nil || !strings.Contains(kindName, "/") {
		return "", errors.New("target must be kind/name")
	}
	a, err := s.args(false)
	if err != nil {
		return "", err
	}
	a = append(a, "delete", kindName, "--wait=false")
	b, err := c.run(ctx, a...)
	return redact.Text(string(b)), err
}

func (c *Client) ScaleZero(ctx context.Context, s Scope, kindName string) (string, error) {
	if err := check("target", kindName); err != nil || !strings.Contains(kindName, "/") {
		return "", errors.New("target must be kind/name")
	}
	a, err := s.args(false)
	if err != nil {
		return "", err
	}
	a = append(a, "scale", kindName, "--replicas=0")
	b, err := c.run(ctx, a...)
	return redact.Text(string(b)), err
}
