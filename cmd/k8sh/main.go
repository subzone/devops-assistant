// k8sh — GitOps-first Kubernetes operations core for the k8s-handler Claude plugin.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/subzone/k8s-handler/internal/audit"
	"github.com/subzone/k8s-handler/internal/config"
	"github.com/subzone/k8s-handler/internal/grant"
	"github.com/subzone/k8s-handler/internal/guard"
	"github.com/subzone/k8s-handler/internal/kube"
	"github.com/subzone/k8s-handler/internal/mcp"
	"github.com/subzone/k8s-handler/internal/settings"
	"github.com/subzone/k8s-handler/internal/tui"
	"github.com/subzone/k8s-handler/internal/validate"
)

var version = "0.2.1"

const usage = `k8sh — GitOps-first Kubernetes operations with a destructive-action lock

Usage:
  k8sh mcp                         run the MCP server on stdio
  k8sh hook pretooluse             Claude Code PreToolUse hook (reads JSON on stdin)
  k8sh unlock --context C --action A --target kind/name [--namespace N] [--ttl 10m]
                                   USER ONLY: issue a single-use grant (interactive terminal)
  k8sh lock                        revoke all grants
  k8sh grants                      list active grants
  k8sh actions                     list actions that require a grant
  k8sh validate PATH [--strict] [--context C]
                                   run the validation pipeline (exit 1 on failure)
  k8sh tui                         interactive UI (clickable trees: Cluster, Argo CD, RCA, Lock)
  k8sh tui --open                  open the TUI in a new tmux/WezTerm/kitty pane or terminal window
  k8sh config show                 show context tiers and grant TTL ceiling
  k8sh config set-tier CONTEXT dev|staging|prod
  k8sh config set-ttl MINUTES      grant TTL ceiling (1-15)
  k8sh settings apply [--path P] [--statusline CMD] [--force-statusline] [--dry-run]
                                   merge deny-list + status line into Claude settings (add-only, .bak kept)
  k8sh statusline                  one-line status for the Claude Code status line
  k8sh audit [--tail N]            show the redacted audit log
  k8sh version
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	home, err := config.EnsureHome()
	must(err)
	cfg, err := config.Load()
	must(err)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	switch os.Args[1] {
	case "mcp":
		s := mcp.NewServer("k8sh", version)
		mcp.Register(s, mcp.Deps{Home: home, Kube: kube.New(), Grants: grant.NewStore(home), Config: cfg})
		must(s.Serve(ctx, os.Stdin, os.Stdout))
	case "hook":
		if len(os.Args) < 3 || os.Args[2] != "pretooluse" {
			fail("usage: k8sh hook pretooluse")
		}
		os.Exit(hookPreToolUse(home, os.Stdin, os.Stdout))
	case "unlock":
		unlock(ctx, home, cfg, os.Args[2:])
	case "lock":
		n, err := grant.NewStore(home).RevokeAll()
		must(err)
		audit.Write(home, audit.Record{Source: "cli", Event: "lock", Outcome: fmt.Sprintf("revoked %d", n)})
		fmt.Printf("🔒 locked (%d grant(s) revoked)\n", n)
	case "grants":
		gs, err := grant.NewStore(home).List()
		must(err)
		if len(gs) == 0 {
			fmt.Println("🔒 locked — no active grants")
			return
		}
		for _, g := range gs {
			fmt.Printf("%s  %s/%s  %s %s  expires in %s\n", g.ID, g.Context, dash(g.Namespace), g.Action, g.Target, time.Until(g.ExpiresAt).Round(time.Second))
		}
	case "actions":
		keys := make([]string, 0, len(grant.Actions))
		for k := range grant.Actions {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Printf("%-20s %s\n", k, grant.Actions[k])
		}
	case "tui":
		if len(os.Args) > 2 && os.Args[2] == "--open" {
			openTUI()
			return
		}
		must(tui.Run(ctx, home, cfg))
	case "config":
		runConfig(cfg, os.Args[2:])
	case "settings":
		runSettings(os.Args[2:])
	case "validate":
		runValidate(ctx, os.Args[2:])
	case "statusline":
		statusline(ctx, home, cfg)
	case "audit":
		fs := flag.NewFlagSet("audit", flag.ExitOnError)
		n := fs.Int("tail", 50, "lines")
		fs.Parse(os.Args[2:])
		b, _ := os.ReadFile(home + "/audit.log")
		lines := strings.Split(strings.TrimSpace(string(b)), "\n")
		if len(lines) > *n {
			lines = lines[len(lines)-*n:]
		}
		fmt.Println(strings.Join(lines, "\n"))
	case "version", "--version", "-v":
		fmt.Println("k8sh", version)
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func hookPreToolUse(home string, in io.Reader, out io.Writer) int {
	var ev struct {
		ToolName  string         `json:"tool_name"`
		ToolInput map[string]any `json:"tool_input"`
	}
	b, err := io.ReadAll(io.LimitReader(in, 4<<20))
	d := guard.Decision{Allow: true}
	if err != nil || json.Unmarshal(b, &ev) != nil {
		d = guard.Decision{Reason: "k8sh hook could not parse tool input (failing closed)"}
	} else {
		d = guard.Evaluate(ev.ToolName, ev.ToolInput)
	}
	if d.Allow {
		return 0
	}
	audit.Write(home, audit.Record{Source: "hook", Event: ev.ToolName, Outcome: "denied", Detail: map[string]any{"reason": d.Reason, "input": ev.ToolInput}})
	json.NewEncoder(out).Encode(map[string]any{
		"hookSpecificOutput": map[string]any{
			"hookEventName":            "PreToolUse",
			"permissionDecision":       "deny",
			"permissionDecisionReason": "k8sh guardrail: " + d.Reason,
		},
	})
	return 0
}

func unlock(ctx context.Context, home string, cfg *config.Config, args []string) {
	fs := flag.NewFlagSet("unlock", flag.ExitOnError)
	c := fs.String("context", "", "kube context (required)")
	ns := fs.String("namespace", "", "namespace")
	action := fs.String("action", "", "action (see k8sh actions)")
	target := fs.String("target", "", "kind/name (exact, no wildcards)")
	ttl := fs.Duration("ttl", 10*time.Minute, "lifetime (max 15m)")
	fs.Parse(args)
	if *ns == "-" {
		*ns = ""
	}
	tty, closeTTY, err := grant.OpenTTY()
	if err != nil {
		audit.Write(home, audit.Record{Source: "cli", Event: "unlock", Outcome: "refused", Detail: map[string]any{"reason": err.Error()}})
		fail(err.Error())
	}
	defer closeTTY()
	g, err := grant.NewStore(home).Issue(grant.Request{Context: *c, Namespace: *ns, Action: *action, Target: *target, TTL: *ttl, Tier: string(cfg.TierOf(*c))},
		tty, time.Duration(cfg.MaxTTLMinutes())*time.Minute)
	if err != nil {
		audit.Write(home, audit.Record{Source: "cli", Event: "unlock", Outcome: "refused", Detail: map[string]any{"reason": err.Error(), "context": *c, "action": *action, "target": *target}})
		fail(err.Error())
	}
	audit.Write(home, audit.Record{Source: "cli", Event: "unlock", Outcome: "granted", Detail: map[string]any{"grant": g.ID, "context": g.Context, "namespace": g.Namespace, "action": g.Action, "target": g.Target, "expires": g.ExpiresAt}})
	fmt.Fprintf(tty, "\n  🔓 granted %s — single use, expires %s\n", g.ID, g.ExpiresAt.Local().Format("15:04:05"))
}

func runValidate(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	strict := fs.Bool("strict", false, "fail if scanners are missing")
	kctx := fs.String("context", "", "also run server-side dry-run against this context")
	asJSON := fs.Bool("json", false, "JSON output")
	var path string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		path, args = args[0], args[1:]
	}
	fs.Parse(args)
	if path == "" {
		path = fs.Arg(0)
	}
	if path == "" {
		fail("usage: k8sh validate PATH [--strict] [--context C]")
	}
	o := validate.Options{Strict: *strict}
	if *kctx != "" {
		k := kube.New()
		o.DryRun = func(ctx context.Context, f string) (string, error) { return k.DryRunServer(ctx, *kctx, f) }
	}
	r, err := validate.Run(ctx, path, o)
	must(err)
	if *asJSON {
		json.NewEncoder(os.Stdout).Encode(r)
	} else {
		for _, s := range r.Stages {
			icon := map[validate.Status]string{validate.Pass: "✔", validate.Fail: "✖", validate.Skipped: "·"}[s.Status]
			req := ""
			if s.Required {
				req = " (required)"
			}
			fmt.Printf("%s %s%s\n", icon, s.Name, req)
			if s.Status == validate.Fail && s.Output != "" {
				for _, l := range strings.Split(strings.TrimSpace(s.Output), "\n") {
					fmt.Println("    " + l)
				}
			}
		}
	}
	if !r.Passed {
		os.Exit(1)
	}
}

func runConfig(cfg *config.Config, args []string) {
	if len(args) == 0 {
		args = []string{"show"}
	}
	switch args[0] {
	case "show":
		json.NewEncoder(os.Stdout).Encode(map[string]any{
			"contexts":           cfg.Contexts,
			"maxGrantTTLMinutes": cfg.MaxTTLMinutes(),
			"note":               "contexts not listed are treated as prod; tiers never relax the destructive-action lock",
		})
		return
	case "set-tier":
		if len(args) != 3 {
			fail("usage: k8sh config set-tier CONTEXT dev|staging|prod")
		}
		must(cfg.SetTier(args[1], config.Tier(args[2])))
	case "set-ttl":
		var m int
		if len(args) != 2 {
			fail("usage: k8sh config set-ttl MINUTES")
		}
		fmt.Sscanf(args[1], "%d", &m)
		must(cfg.SetMaxTTL(m))
	default:
		fail("unknown config subcommand " + args[0])
	}
	must(cfg.Save())
	home, _ := config.Home()
	audit.Write(home, audit.Record{Source: "cli", Event: "config " + args[0], Outcome: "saved", Detail: map[string]any{"args": args[1:]}})
	fmt.Println("saved", strings.Join(args, " "))
}

func runSettings(args []string) {
	if len(args) == 0 || args[0] != "apply" {
		fail("usage: k8sh settings apply [--path P] [--statusline CMD] [--force-statusline] [--dry-run]")
	}
	def, _ := settings.DefaultPath()
	fs := flag.NewFlagSet("settings", flag.ExitOnError)
	path := fs.String("path", def, "Claude Code settings.json")
	sl := fs.String("statusline", "", "status line command to set (empty = leave alone)")
	force := fs.Bool("force-statusline", false, "replace an existing status line")
	dry := fs.Bool("dry-run", false, "show what would change")
	fs.Parse(args[1:])
	r, err := settings.Apply(*path, *sl, *force, *dry)
	must(err)
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(r)
}

func statusline(ctx context.Context, home string, cfg *config.Config) {
	io.Copy(io.Discard, io.LimitReader(os.Stdin, 1<<20)) // Claude Code sends session JSON; unused
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cur, _ := kube.New().CurrentContext(cctx)
	if cur == "" {
		cur = "none"
	}
	gs, _ := grant.NewStore(home).List()
	lock := "🔒"
	if len(gs) > 0 {
		lock = fmt.Sprintf("🔓%d (%s)", len(gs), time.Until(gs[0].ExpiresAt).Round(time.Second))
	}
	fmt.Printf("k8s %s [%s] %s", cur, cfg.TierOf(cur), lock)
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func must(err error) {
	if err != nil {
		fail(err.Error())
	}
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "k8sh:", msg)
	os.Exit(1)
}

// openTUI launches "k8sh tui" in a separate pane/window the user controls.
func openTUI() {
	self, err := os.Executable()
	must(err)
	cmdline := shellQuote(self) + " tui"
	try := func(name string, args ...string) bool {
		if _, err := exec.LookPath(name); err != nil {
			return false
		}
		c := exec.Command(name, args...)
		if out, err := c.CombinedOutput(); err != nil {
			fmt.Fprintf(os.Stderr, "%s: %v %s\n", name, err, strings.TrimSpace(string(out)))
			return false
		}
		fmt.Println("opened k8sh TUI via", name)
		return true
	}
	switch {
	case os.Getenv("TMUX") != "" && try("tmux", "split-window", "-h", "-l", "60%", cmdline):
	case os.Getenv("WEZTERM_PANE") != "" && try("wezterm", "cli", "split-pane", "--right", "--percent", "60", "--", self, "tui"):
	case os.Getenv("KITTY_WINDOW_ID") != "" && try("kitty", "@", "launch", "--location=vsplit", self, "tui"):
	case runtime.GOOS == "darwin" && os.Getenv("TERM_PROGRAM") == "iTerm.app" &&
		try("osascript", "-e", `tell application "iTerm2" to tell current session of current window to split vertically with default profile command "/bin/zsh -lc '`+strings.ReplaceAll(cmdline, `"`, `\"`)+`'"`):
	default:
		fmt.Println("This terminal can't be split from a script. To get the TUI as a right-side pane next to Claude:")
		fmt.Println("  - iTerm2 / WezTerm / kitty: supported automatically")
		fmt.Println("  - any terminal: start Claude inside tmux (tmux new -s k8s 'claude'), then /k8s-handler:ui")
		fmt.Println("Or run it yourself in a split pane:")
		fmt.Println("  " + cmdline)
	}
}

func shellQuote(s string) string {
	if !strings.ContainsAny(s, " '\"$`\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
