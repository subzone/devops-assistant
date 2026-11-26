// Package tui is the interactive k8sh terminal UI: clickable, expandable
// trees for Cluster, Argo CD, RCA and Lock views. Standard library only.
package tui

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/subzone/k8s-handler/internal/audit"
	"github.com/subzone/k8s-handler/internal/config"
	"github.com/subzone/k8s-handler/internal/focus"
	"github.com/subzone/k8s-handler/internal/grant"
	"github.com/subzone/k8s-handler/internal/kube"
)

type crumb struct {
	x0, x1 int
	n      *node
}

var tabs = []string{"Cluster", "Argo CD", "RCA", "Lock"}

type App struct {
	home     string
	cfg      *config.Config
	k        *kube.Client
	ld       *loader
	contexts []string
	kctx     string
	tab      int
	roots    [][]*node
	sel      []int
	off      []int
	dscroll  int
	extra    []string // detail override (events/logs)
	msg      string
	rows     int
	cols     int
	t        *term
	out      *bufio.Writer
	listTop  int
	tabStart int
	crumbs   []crumb
	keys     <-chan []byte
	menu     *menu
	quit     bool
	buttons  []button
	ctxX0    int
	ctxX1    int
}

func Run(ctx context.Context, home string, cfg *config.Config) error {
	k := kube.New()
	cs, cur, err := k.Contexts(ctx)
	if err != nil {
		return fmt.Errorf("kubectl: %w", err)
	}
	if cur == "" && len(cs) > 0 {
		cur = cs[0]
	}
	t, err := openTerm()
	if err != nil {
		return err
	}
	a := &App{home: home, cfg: cfg, k: k, ld: &loader{k: k, ctx: ctx}, contexts: cs, kctx: cur, t: t,
		roots: make([][]*node, len(tabs)), sel: make([]int, len(tabs)), off: make([]int, len(tabs)),
		out: bufio.NewWriterSize(os.Stdout, 1<<16)}
	a.out.WriteString("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h")
	a.out.Flush()
	defer func() {
		a.out.WriteString("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l")
		a.out.Flush()
		t.restore()
	}()
	resize := make(chan os.Signal, 1)
	notifyResize(resize)
	keys := make(chan []byte, 16)
	go func() {
		buf := make([]byte, 256)
		for {
			n, err := os.Stdin.Read(buf)
			if err != nil {
				close(keys)
				return
			}
			b := make([]byte, n)
			copy(b, buf[:n])
			keys <- b
		}
	}()
	a.keys = keys
	a.rows, a.cols = termSize()
	a.reload()
	for {
		a.draw()
		select {
		case <-ctx.Done():
			return nil
		case <-resize:
			a.rows, a.cols = termSize()
		case b, ok := <-keys:
			if !ok {
				return nil
			}
			if quit := a.handle(b, keys); quit || a.quit {
				return nil
			}
		}
	}
}

// ---------- tree helpers ----------

func (a *App) visible() []*node {
	var out []*node
	var walk func(ns []*node)
	walk = func(ns []*node) {
		for _, n := range ns {
			out = append(out, n)
			if n.expanded {
				walk(n.children)
			}
		}
	}
	walk(a.roots[a.tab])
	return out
}

func (a *App) current() *node {
	v := a.visible()
	if len(v) == 0 {
		return nil
	}
	i := a.sel[a.tab]
	if i >= len(v) {
		i = len(v) - 1
		a.sel[a.tab] = i
	}
	return v[i]
}

func setLevels(ns []*node, lvl int, parent *node) {
	for _, n := range ns {
		n.level, n.parent = lvl, parent
		setLevels(n.children, lvl+1, n)
	}
}

func (a *App) toggle(n *node) {
	if n == nil || !n.expandable() {
		return
	}
	if n.expanded {
		n.expanded = false
		return
	}
	if !n.loaded && n.load != nil {
		a.status("loading " + n.label + " …")
		kids, err := n.load()
		if err != nil {
			a.msg = "error: " + err.Error()
			return
		}
		n.children, n.loaded = kids, true
		setLevels(n.children, n.level+1, n)
	}
	n.expanded = true
}

func (a *App) reload() {
	a.extra, a.dscroll = nil, 0
	a.status("loading " + tabs[a.tab] + " …")
	var ns []*node
	var err error
	switch a.tab {
	case 0:
		ns, err = a.ld.namespaces(a.kctx)
	case 1:
		ns, err = a.ld.argoApps(a.kctx)
	case 2:
		ns, err = a.ld.rca(a.kctx)
	case 3:
		ns = a.lockNodes()
	}
	if err != nil {
		ns = []*node{{label: "error: " + err.Error(), status: stErr, kind: "Info"}}
	}
	setLevels(ns, 0, nil)
	a.roots[a.tab] = ns
	a.sel[a.tab], a.off[a.tab] = 0, 0
	a.msg = ""
}

func (a *App) lockNodes() []*node {
	tier := a.cfg.TierOf(a.kctx)
	gs, _ := grant.NewStore(a.home).List()
	state := &node{label: fmt.Sprintf("LOCKED  context %s [%s]", a.kctx, tier), status: stOK, kind: "Info",
		detail: []string{"Destructive actions are locked.", "", "Grants are single-use, exact-scope, max 15 min.",
			"Select a pod/workload in Cluster and press u to issue one,", "or run in your terminal:",
			"  k8sh unlock --context C --namespace N --action A --target kind/name", "", "k8sh lock revokes all grants."}}
	out := []*node{state}
	if len(gs) > 0 {
		state.label = fmt.Sprintf("UNLOCKED x%d  context %s [%s]", len(gs), a.kctx, tier)
		state.status = stWarn
		for _, g := range gs {
			out = append(out, &node{label: fmt.Sprintf("grant %s  %s %s  %s/%s  expires %s", g.ID[:6], g.Action, g.Target, g.Context, dash(g.Namespace), time.Until(g.ExpiresAt).Round(time.Second)),
				status: stWarn, kind: "Grant", detail: []string{"Grant " + g.ID, "context: " + g.Context, "namespace: " + dash(g.Namespace), "action: " + g.Action, "target: " + g.Target, "expires: " + g.ExpiresAt.Local().Format("15:04:05")}})
		}
	}
	out = append(out, &node{label: "contexts and tiers", kind: "Info", loaded: true, children: a.tierNodes()})
	return out
}

func (a *App) tierNodes() []*node {
	var out []*node
	for _, c := range a.contexts {
		st := stErr
		switch a.cfg.TierOf(c) {
		case config.TierDev:
			st = stOK
		case config.TierStaging:
			st = stWarn
		}
		out = append(out, &node{label: fmt.Sprintf("%s  [%s]", c, a.cfg.TierOf(c)), status: st, kind: "Info",
			detail: []string{"context " + c, "tier: " + string(a.cfg.TierOf(c)), "", "change: k8sh config set-tier " + c + " dev|staging|prod"}})
	}
	return out
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// ---------- input ----------

func (a *App) move(d int) {
	v := a.visible()
	a.sel[a.tab] += d
	if a.sel[a.tab] < 0 {
		a.sel[a.tab] = 0
	}
	if a.sel[a.tab] >= len(v) {
		a.sel[a.tab] = len(v) - 1
	}
	a.extra, a.dscroll = nil, 0
}

func (a *App) handle(b []byte, keys <-chan []byte) bool {
	a.msg = ""
	if a.menu != nil {
		return a.menuInput(string(b))
	}
	s := string(b)
	for len(s) > 0 {
		switch {
		case strings.HasPrefix(s, "\x1b[<"):
			end := strings.IndexAny(s, "Mm")
			if end < 0 {
				return false
			}
			a.mouse(s[3:end], s[end] == 'M')
			s = s[end+1:]
			continue
		case strings.HasPrefix(s, "\x1b[A"), strings.HasPrefix(s, "\x1bOA"):
			a.move(-1)
			s = s[3:]
			continue
		case strings.HasPrefix(s, "\x1b[B"), strings.HasPrefix(s, "\x1bOB"):
			a.move(1)
			s = s[3:]
			continue
		case strings.HasPrefix(s, "\x1b[C"):
			if n := a.current(); n != nil && !n.expanded {
				a.toggle(n)
			}
			s = s[3:]
			continue
		case strings.HasPrefix(s, "\x1b[D"):
			a.collapseOrParent()
			s = s[3:]
			continue
		case strings.HasPrefix(s, "\x1b[5~"):
			a.move(-(a.bodyRows() - 1))
			s = s[4:]
			continue
		case strings.HasPrefix(s, "\x1b[6~"):
			a.move(a.bodyRows() - 1)
			s = s[4:]
			continue
		case strings.HasPrefix(s, "\x1b[Z"): // shift-tab
			a.tab = (a.tab + len(tabs) - 1) % len(tabs)
			a.ensureTab()
			s = s[3:]
			continue
		case strings.HasPrefix(s, "\x1b[H"), strings.HasPrefix(s, "\x1b[1~"), strings.HasPrefix(s, "\x1bOH"):
			a.top(false)
			s = s[strings.IndexAny(s[1:], "H~")+2:]
			continue
		case strings.HasPrefix(s, "\x1b[F"), strings.HasPrefix(s, "\x1b[4~"), strings.HasPrefix(s, "\x1bOF"):
			a.move(1 << 20)
			s = s[strings.IndexAny(s[1:], "F~")+2:]
			continue
		case s == "\x1b":
			a.back()
			return false
		case s[0] == 0x1b:
			s = s[1:]
			continue
		}
		c := s[0]
		s = s[1:]
		switch c {
		case 'q', 3:
			return true
		case 'j':
			a.move(1)
		case 'k':
			a.move(-1)
		case 'h':
			a.collapseOrParent()
		case 0x7f, 0x08, 'b':
			a.back()
		case 'g':
			a.top(false)
		case 'G':
			a.move(1 << 20)
		case '0', 'H':
			a.top(true)
		case 'J':
			a.dscroll += 5
		case 'K':
			a.dscroll -= 5
			if a.dscroll < 0 {
				a.dscroll = 0
			}
		case '\r', '\n', ' ':
			if n := a.current(); n != nil && !n.expandable() && c != ' ' {
				a.openActions(0, 0)
			} else {
				a.toggle(n)
			}
		case 'm':
			a.openActions(0, 0)
		case 'C':
			a.openContexts()
		case 'd':
			a.describe()
		case 'l':
			a.logs()
		case '\t':
			a.tab = (a.tab + 1) % len(tabs)
			a.ensureTab()
		case '1', '2', '3', '4':
			a.tab = int(c - '1')
			a.ensureTab()
		case 'r':
			a.reload()
		case 'c':
			a.nextContext()
		case 'e':
			a.events()
		case 'f':
			a.sendFocus()
		case 'u':
			a.unlock(keys, "")
		case '?':
			a.extra = helpLines
			a.dscroll = 0
		}
	}
	return false
}

func (a *App) ensureTab() {
	a.extra, a.dscroll = nil, 0
	if a.roots[a.tab] == nil || a.tab == 3 {
		a.reload()
	}
}

func (a *App) collapseOrParent() {
	n := a.current()
	if n == nil {
		return
	}
	if n.expanded {
		n.expanded = false
		return
	}
	if n.parent != nil {
		for i, v := range a.visible() {
			if v == n.parent {
				a.sel[a.tab] = i
				break
			}
		}
	}
}

// back: close detail overlay, else collapse, else go to parent and collapse it.
func (a *App) back() {
	if a.extra != nil {
		a.extra, a.dscroll = nil, 0
		return
	}
	n := a.current()
	if n == nil {
		return
	}
	if n.expanded {
		n.expanded = false
		return
	}
	if p := n.parent; p != nil {
		p.expanded = false
		a.selectNode(p)
	}
}

// top jumps to the first row; collapse=true also folds every tree.
func (a *App) top(collapse bool) {
	if collapse {
		var fold func(ns []*node)
		fold = func(ns []*node) {
			for _, n := range ns {
				n.expanded = false
				fold(n.children)
			}
		}
		fold(a.roots[a.tab])
		a.msg = "collapsed to top level"
	}
	a.sel[a.tab], a.off[a.tab] = 0, 0
	a.extra, a.dscroll = nil, 0
}

func (a *App) selectNode(t *node) {
	for i, v := range a.visible() {
		if v == t {
			a.sel[a.tab] = i
			break
		}
	}
	a.extra, a.dscroll = nil, 0
}

// breadcrumb returns the path from the root to the selection.
func (a *App) breadcrumb() []*node {
	var path []*node
	for n := a.current(); n != nil; n = n.parent {
		path = append([]*node{n}, path...)
	}
	return path
}

func (a *App) mouse(params string, press bool) {
	p := strings.Split(params, ";")
	if len(p) != 3 || !press {
		return
	}
	btn, _ := strconv.Atoi(p[0])
	x, _ := strconv.Atoi(p[1])
	y, _ := strconv.Atoi(p[2])
	switch btn {
	case 64:
		a.move(-3)
		return
	case 65:
		a.move(3)
		return
	case 0, 2:
	default:
		return
	}
	if y == a.rows { // footer buttons
		for _, bt := range a.buttons {
			if x >= bt.x0 && x < bt.x1 {
				bt.act()
				return
			}
		}
		return
	}
	if y == 1 && x <= 8 {
		a.mainMenu()
		return
	}
	if y == 1 && x >= a.ctxX0 && x < a.ctxX1 {
		a.openContexts()
		return
	}
	if btn == 2 { // right-click: select row, open actions there
		row := y - a.listTop
		idx := a.off[a.tab] + row
		if v := a.visible(); row >= 0 && idx < len(v) && x <= a.leftWidth() {
			a.sel[a.tab] = idx
			a.extra, a.dscroll = nil, 0
			a.openActions(x, y)
		}
		return
	}
	if y == 1 { // tab bar click
		pos := a.tabStart
		for i, t := range tabs {
			w := utf8.RuneCountInString(t) + 3
			if x >= pos && x < pos+w {
				if i == a.tab {
					a.top(true)
					return
				}
				a.tab = i
				a.ensureTab()
				return
			}
			pos += w
		}
		return
	}
	if y == 2 { // breadcrumb click
		for _, c := range a.crumbs {
			if x >= c.x0 && x < c.x1 {
				if c.n == nil {
					a.top(true)
				} else {
					c.n.expanded = false
					a.selectNode(c.n)
				}
				return
			}
		}
		return
	}
	row := y - a.listTop
	if row < 0 || row >= a.bodyRows() || x > a.leftWidth() {
		return
	}
	idx := a.off[a.tab] + row
	v := a.visible()
	if idx >= len(v) {
		return
	}
	if a.sel[a.tab] == idx {
		a.toggle(v[idx])
	} else {
		a.sel[a.tab] = idx
		a.extra, a.dscroll = nil, 0
		// click on the arrow toggles immediately
		if x <= 2*v[idx].level+3 {
			a.toggle(v[idx])
		}
	}
}

func (a *App) nextContext() {
	if len(a.contexts) < 2 {
		a.msg = "only one context available"
		return
	}
	for i, c := range a.contexts {
		if c == a.kctx {
			a.kctx = a.contexts[(i+1)%len(a.contexts)]
			break
		}
	}
	a.roots = make([][]*node, len(tabs))
	a.reload()
	a.msg = "context: " + a.kctx + " (kubectl current-context unchanged)"
}

func (a *App) events() {
	n := a.current()
	if n == nil || n.name == "" {
		return
	}
	a.status("loading events …")
	ev, err := a.k.Events(context.Background(), kube.Scope{Context: a.kctx, Namespace: n.ns}, false)
	if err != nil {
		a.msg = "error: " + err.Error()
		return
	}
	target := n.name
	if n.kind == "Container" {
		target = n.pod
	}
	lines := []string{"Events for " + target}
	for _, e := range ev {
		if strings.HasSuffix(e.Object, "/"+target) || strings.Contains(e.Object, "/"+target+"-") {
			lines = append(lines, fmt.Sprintf("%s %s %s: %s", e.Last, e.Type, e.Reason, e.Message))
		}
	}
	if len(lines) == 1 {
		lines = append(lines, "(none)")
	}
	a.extra, a.dscroll = lines, 0
	a.msg = ""
}

func (a *App) logs() {
	n := a.current()
	if n == nil || (n.kind != "Pod" && n.kind != "Container") {
		a.msg = "select a pod or container for logs"
		return
	}
	pod, c := n.name, ""
	if n.kind == "Container" {
		pod, c = n.pod, n.name
	}
	a.status("loading logs …")
	out, err := a.k.Logs(context.Background(), kube.Scope{Context: a.kctx, Namespace: n.ns}, pod, c, 200, false)
	if err != nil {
		out = err.Error()
	}
	a.extra = append([]string{"Logs " + pod + " " + c + " (last 200, redacted)"}, strings.Split(strings.TrimRight(out, "\n"), "\n")...)
	a.dscroll = len(a.extra) // jump to bottom
	a.msg = ""
}

func (a *App) detailLines() []string {
	if a.extra != nil {
		return a.extra
	}
	if n := a.current(); n != nil {
		return n.detail
	}
	return nil
}

func (a *App) sendFocus() {
	n := a.current()
	if n == nil {
		return
	}
	name := n.name
	if n.kind == "Container" {
		name = n.pod + "/" + n.name
	}
	f := focus.Focus{Context: a.kctx, Tier: string(a.cfg.TierOf(a.kctx)), View: tabs[a.tab], Namespace: n.ns,
		Kind: n.kind, Name: name, Status: n.label, Detail: strings.Join(append(append([]string{}, n.detail...), a.extra...), "\n")}
	if err := focus.Write(a.home, f); err != nil {
		a.msg = "error: " + err.Error()
		return
	}
	a.msg = "sent to Claude — ask: /k8s-handler:explain"
}

// unlock issues a grant for the selected object from inside the TUI.
func (a *App) unlock(keys <-chan []byte, preset string) {
	n := a.current()
	if n == nil {
		return
	}
	var actions []string
	target := ""
	switch n.kind {
	case "Pod":
		actions, target = []string{"delete"}, "pod/"+n.name
	case "Deployment", "StatefulSet":
		actions, target = []string{"delete", "scale-zero"}, strings.ToLower(n.kind)+"/"+n.name
	case "DaemonSet":
		actions, target = []string{"delete"}, "daemonset/"+n.name
	default:
		a.msg = "unlock works on pods and workloads (Cluster view)"
		return
	}
	action := actions[0]
	if preset != "" {
		action = preset
	} else if len(actions) > 1 {
		a.msg = "unlock: d = delete, z = scale to 0, any other key = cancel"
		a.draw()
		b, ok := <-keys
		if !ok || len(b) == 0 {
			return
		}
		switch b[0] {
		case 'd':
			action = "delete"
		case 'z':
			action = "scale-zero"
		default:
			a.msg = "cancelled"
			return
		}
	}
	// leave raw mode / alt screen for the confirmation prompt
	a.out.WriteString("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l")
	a.out.Flush()
	a.t.restore()
	tty, closeTTY, err := grant.OpenTTY()
	var g *grant.Grant
	if err == nil {
		g, err = grant.NewStore(a.home).Issue(grant.Request{Context: a.kctx, Namespace: n.ns, Action: action, Target: target, TTL: 10 * time.Minute, Tier: string(a.cfg.TierOf(a.kctx))},
			tty, time.Duration(a.cfg.MaxTTLMinutes())*time.Minute)
		closeTTY()
	}
	detail := map[string]any{"context": a.kctx, "namespace": n.ns, "action": action, "target": target}
	if err != nil {
		audit.Write(a.home, audit.Record{Source: "tui", Event: "unlock", Outcome: "refused", Detail: map[string]any{"reason": err.Error()}})
		a.msg = "not unlocked: " + err.Error()
	} else {
		detail["grant"] = g.ID
		audit.Write(a.home, audit.Record{Source: "tui", Event: "unlock", Outcome: "granted", Detail: detail})
		a.msg = fmt.Sprintf("granted %s %s (single use, %s) — tell Claude to proceed", action, target, time.Until(g.ExpiresAt).Round(time.Minute))
	}
	a.t.raw()
	a.out.WriteString("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h")
	a.out.Flush()
	if a.tab == 3 {
		a.reload()
	}
	// drain keys typed during the prompt
	for {
		select {
		case <-keys:
		default:
			return
		}
	}
}

var helpLines = []string{
	"k8sh TUI — keys",
	"",
	"↑/↓ j/k        move          click     select / toggle",
	"enter/space →  expand        ←/h       collapse / parent",
	"esc/backspace  back (close logs/events, collapse, go up)",
	"0/H            collapse all, back to top    g/G  first/last",
	"click a breadcrumb segment to jump back; click the active tab to collapse all",
	"tab 1-4        switch view   wheel     scroll",
	"J/K            scroll detail PgUp/PgDn page",
	"e              events        l         logs (pod/container)",
	"f              send selection to Claude (/k8s-handler:explain)",
	"u              unlock ONE destructive action for selection",
	"c              next context  r         refresh",
	"m / right-click action menu for the selection (enter on a leaf too)",
	"d              describe      C / click context   switch context",
	"footer buttons are clickable",
	"q              quit",
	"",
	"Secrets and tokens are redacted in every view.",
}
