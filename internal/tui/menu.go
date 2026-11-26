package tui

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/subzone/k8s-handler/internal/kube"
)

type menuItem struct {
	label  string
	key    string
	danger bool
	act    func()
}

type menu struct {
	title string
	items []menuItem
	sel   int
	x, y  int // top-left (1-based); 0 = auto
	// computed on draw
	bx, by, bw, bh int
}

type button struct {
	x0, x1 int
	act    func()
}

// openActions shows the context menu for the selected node.
func (a *App) openActions(x, y int) {
	n := a.current()
	if n == nil {
		return
	}
	var it []menuItem
	if n.expandable() {
		lbl := "Expand"
		if n.expanded {
			lbl = "Collapse"
		}
		it = append(it, menuItem{label: lbl, key: "⏎", act: func() { a.toggle(n) }})
	}
	switch n.kind {
	case "Pod":
		it = append(it,
			menuItem{label: "Logs", key: "l", act: a.logs},
			menuItem{label: "Logs (previous container)", act: func() { a.logsPrev() }},
			menuItem{label: "Events", key: "e", act: a.events},
			menuItem{label: "Describe", key: "d", act: a.describe},
		)
	case "Container":
		it = append(it,
			menuItem{label: "Logs", key: "l", act: a.logs},
			menuItem{label: "Logs (previous)", act: func() { a.logsPrev() }},
			menuItem{label: "Events (pod)", key: "e", act: a.events},
		)
	case "Deployment", "StatefulSet", "DaemonSet", "Namespace":
		it = append(it,
			menuItem{label: "Events", key: "e", act: a.events},
			menuItem{label: "Describe", key: "d", act: a.describe},
		)
	case "Application":
		it = append(it, menuItem{label: "Describe", key: "d", act: a.describe})
	}
	if n.kind != "Info" {
		it = append(it, menuItem{label: "Send to Claude", key: "f", act: a.sendFocus})
		it = append(it, menuItem{label: "Ask Claude: what's wrong?", act: func() {
			a.sendFocus()
			a.msg = "selection sent — in Claude run: /k8s-handler:explain what's wrong?"
		}})
	}
	switch n.kind {
	case "Pod", "DaemonSet":
		it = append(it, menuItem{label: "Unlock: delete…", key: "u", danger: true, act: func() { a.unlock(a.keys, "delete") }})
	case "Deployment", "StatefulSet":
		it = append(it,
			menuItem{label: "Unlock: delete…", danger: true, act: func() { a.unlock(a.keys, "delete") }},
			menuItem{label: "Unlock: scale to 0…", danger: true, act: func() { a.unlock(a.keys, "scale-zero") }},
		)
	}
	it = append(it, menuItem{label: "Refresh view", key: "r", act: a.reload})
	title := n.kind
	if n.name != "" {
		title += " " + n.name
	}
	a.menu = &menu{title: title, items: it, x: x, y: y}
}

func (a *App) openContexts() {
	var it []menuItem
	for _, c := range a.contexts {
		c := c
		lbl := fmt.Sprintf("%s  [%s]", c, a.cfg.TierOf(c))
		if c == a.kctx {
			lbl = "● " + lbl
		} else {
			lbl = "  " + lbl
		}
		it = append(it, menuItem{label: lbl, act: func() {
			if c != a.kctx {
				a.kctx = c
				a.roots = make([][]*node, len(tabs))
				a.reload()
				a.msg = "context: " + c + " (kubectl current-context unchanged)"
			}
		}})
	}
	a.menu = &menu{title: "Context", items: it, x: a.ctxX0, y: 2}
}

func (a *App) mainMenu() {
	a.menu = &menu{title: "Menu", x: 1, y: 2, items: []menuItem{
		{label: "Cluster view", key: "1", act: func() { a.tab = 0; a.ensureTab() }},
		{label: "Argo CD view", key: "2", act: func() { a.tab = 1; a.ensureTab() }},
		{label: "RCA view", key: "3", act: func() { a.tab = 2; a.ensureTab() }},
		{label: "Lock view", key: "4", act: func() { a.tab = 3; a.ensureTab() }},
		{label: "Switch context…", key: "C", act: a.openContexts},
		{label: "Collapse all / top", key: "0", act: func() { a.top(true) }},
		{label: "Refresh", key: "r", act: a.reload},
		{label: "Help", key: "?", act: func() { a.extra, a.dscroll = helpLines, 0 }},
		{label: "Quit", key: "q", act: func() { a.quit = true }},
	}}
}

func (a *App) describe() {
	n := a.current()
	if n == nil || n.name == "" || n.kind == "Info" || n.kind == "Finding" || n.kind == "Event" {
		a.msg = "nothing to describe here"
		return
	}
	kind, name, ns := strings.ToLower(n.kind), n.name, n.ns
	if n.kind == "Container" {
		kind, name = "pod", n.pod
	}
	if n.kind == "Application" {
		kind = "applications.argoproj.io"
	}
	a.status("describing " + kind + "/" + name + " …")
	out, err := a.k.Describe(context.Background(), kube.Scope{Context: a.kctx, Namespace: ns}, kind, name)
	if err != nil {
		out = err.Error()
	}
	a.extra, a.dscroll, a.msg = strings.Split(strings.TrimRight(out, "\n"), "\n"), 0, ""
}

func (a *App) logsPrev() {
	n := a.current()
	if n == nil || (n.kind != "Pod" && n.kind != "Container") {
		return
	}
	pod, c := n.name, ""
	if n.kind == "Container" {
		pod, c = n.pod, n.name
	}
	a.status("loading previous logs …")
	out, err := a.k.Logs(context.Background(), kube.Scope{Context: a.kctx, Namespace: n.ns}, pod, c, 200, true)
	if err != nil {
		out = err.Error()
	}
	a.extra = append([]string{"Previous logs " + pod + " " + c + " (redacted)"}, strings.Split(strings.TrimRight(out, "\n"), "\n")...)
	a.dscroll, a.msg = len(a.extra), ""
}

// menuInput handles keys/mouse while a menu is open. Returns quit.
func (a *App) menuInput(s string) bool {
	m := a.menu
	pick := func(i int) {
		if i < 0 || i >= len(m.items) {
			return
		}
		a.menu = nil
		if m.items[i].act != nil {
			m.items[i].act()
		}
	}
	for len(s) > 0 {
		switch {
		case strings.HasPrefix(s, "\x1b[<"):
			end := strings.IndexAny(s, "Mm")
			if end < 0 {
				return a.quit
			}
			p := strings.Split(s[3:end], ";")
			press := s[end] == 'M'
			s = s[end+1:]
			if len(p) != 3 || !press {
				continue
			}
			btn, _ := strconv.Atoi(p[0])
			x, _ := strconv.Atoi(p[1])
			y, _ := strconv.Atoi(p[2])
			switch btn {
			case 64:
				if m.sel > 0 {
					m.sel--
				}
				continue
			case 65:
				if m.sel < len(m.items)-1 {
					m.sel++
				}
				continue
			}
			if x >= m.bx && x < m.bx+m.bw && y > m.by && y < m.by+m.bh-1 {
				pick(y - m.by - 1)
			} else {
				a.menu = nil // click outside closes
			}
			return a.quit
		case strings.HasPrefix(s, "\x1b[A"), strings.HasPrefix(s, "\x1bOA"):
			if m.sel > 0 {
				m.sel--
			}
			s = s[3:]
		case strings.HasPrefix(s, "\x1b[B"), strings.HasPrefix(s, "\x1bOB"):
			if m.sel < len(m.items)-1 {
				m.sel++
			}
			s = s[3:]
		case s == "\x1b" || s[0] == 'q' || s[0] == 'm' || s[0] == 0x7f:
			a.menu = nil
			return false
		case s[0] == 0x1b:
			s = s[1:]
		case s[0] == '\r' || s[0] == '\n' || s[0] == ' ':
			pick(m.sel)
			return a.quit
		case s[0] == 'k':
			if m.sel > 0 {
				m.sel--
			}
			s = s[1:]
		case s[0] == 'j':
			if m.sel < len(m.items)-1 {
				m.sel++
			}
			s = s[1:]
		case s[0] == 3:
			return true
		default:
			// item shortcut key
			for i, it := range m.items {
				if it.key != "" && it.key == s[:1] {
					pick(i)
					return a.quit
				}
			}
			s = s[1:]
		}
	}
	return a.quit
}

// drawMenu renders the open menu as a bordered overlay.
func (a *App) drawMenu() {
	m := a.menu
	if m == nil {
		return
	}
	w := utf8.RuneCountInString(m.title) + 4
	for _, it := range m.items {
		if l := utf8.RuneCountInString(it.label) + 8; l > w {
			w = l
		}
	}
	if w > a.cols-2 {
		w = a.cols - 2
	}
	h := len(m.items) + 2
	x, y := m.x, m.y
	if x == 0 || y == 0 { // auto: next to selected row
		x = 3 + 2*a.current().level
		y = a.listTop + a.sel[a.tab] - a.off[a.tab] + 1
	}
	if x+w > a.cols {
		x = a.cols - w
	}
	if x < 1 {
		x = 1
	}
	if y+h > a.rows {
		y = a.rows - h
	}
	if y < 2 {
		y = 2
	}
	m.bx, m.by, m.bw, m.bh = x, y, w, h
	o := a.out
	at := func(r, c int) { fmt.Fprintf(o, "\x1b[%d;%dH", r, c) }
	title := " " + m.title + " "
	if utf8.RuneCountInString(title) > w-2 {
		title = fit(title, w-2)
	}
	at(y, x)
	o.WriteString(cyan + "┌" + title + strings.Repeat("─", w-2-utf8.RuneCountInString(title)) + "┐" + reset)
	for i, it := range m.items {
		at(y+1+i, x)
		key := ""
		if it.key != "" {
			key = it.key
		}
		body := " " + fit(it.label, w-6) + fit(key, 2) + " "
		col := ""
		if it.danger {
			col = red
		}
		if i == m.sel {
			o.WriteString(cyan + "│" + reset + inverse + col + body + reset + cyan + "│" + reset)
		} else {
			o.WriteString(cyan + "│" + reset + col + body + reset + cyan + "│" + reset)
		}
	}
	at(y+h-1, x)
	o.WriteString(cyan + "└" + strings.Repeat("─", w-2) + "┘" + reset)
}
