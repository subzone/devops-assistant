package tui

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/subzone/k8s-handler/internal/config"
	"github.com/subzone/k8s-handler/internal/grant"
)

const (
	reset   = "\x1b[0m"
	bold    = "\x1b[1m"
	dim     = "\x1b[2m"
	inverse = "\x1b[7m"
	red     = "\x1b[31m"
	green   = "\x1b[32m"
	yellow  = "\x1b[33m"
	cyan    = "\x1b[36m"
)

func icon(st string) (string, string) {
	switch st {
	case stOK:
		return "✔", green
	case stWarn:
		return "⚠", yellow
	case stErr:
		return "✖", red
	}
	return "·", dim
}

func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	n := utf8.RuneCountInString(s)
	if n <= w {
		return s + strings.Repeat(" ", w-n)
	}
	r := []rune(s)
	return string(r[:w-1]) + "…"
}

func (a *App) bodyRows() int {
	r := a.rows - 5
	if r < 3 {
		r = 3
	}
	return r
}

func (a *App) leftWidth() int {
	w := a.cols * 45 / 100
	if w < 30 {
		w = 30
	}
	if w > a.cols-20 {
		w = a.cols - 20
	}
	if w < 10 {
		w = a.cols
	}
	return w
}

// status draws a one-line message immediately (used before slow calls).
func (a *App) status(m string) {
	a.msg = m
	a.draw()
}

func (a *App) draw() {
	o := a.out
	o.WriteString("\x1b[H")
	cols := a.cols

	// line 1: title + tabs + context
	tier := a.cfg.TierOf(a.kctx)
	tc := red
	switch tier {
	case config.TierDev:
		tc = green
	case config.TierStaging:
		tc = yellow
	}
	lock := green + "LOCKED" + reset
	if gs, _ := grant.NewStore(a.home).List(); len(gs) > 0 {
		lock = yellow + fmt.Sprintf("UNLOCKED x%d", len(gs)) + reset
	}
	title := " k8sh "
	o.WriteString(inverse + bold + title + reset + " ")
	used := utf8.RuneCountInString(title) + 1
	a.tabStart = used + 1
	for i, t := range tabs {
		lbl := fmt.Sprintf(" %d %s", i+1, t)
		if i == a.tab {
			o.WriteString(inverse + cyan + lbl + " " + reset)
		} else {
			o.WriteString(dim + lbl + " " + reset)
		}
		used += utf8.RuneCountInString(lbl) + 1
	}
	right := fmt.Sprintf(" %s [%s] %s ", a.kctx, tier, "LOCK")
	pad := cols - used - utf8.RuneCountInString(right)
	if pad > 0 {
		o.WriteString(strings.Repeat(" ", pad))
		o.WriteString(" " + a.kctx + " [" + tc + string(tier) + reset + "] " + lock + "\x1b[K")
	} else {
		o.WriteString("\x1b[K")
	}
	o.WriteString("\r\n")

	// line 2: separator
	lw := a.leftWidth()
	rw := cols - lw - 1
	// line 2: clickable breadcrumb (⌂ = top level), then separator
	a.crumbs = a.crumbs[:0]
	path := a.breadcrumb()
	col := 1
	var bc strings.Builder
	addSeg := func(text string, n *node, last bool) {
		w := utf8.RuneCountInString(text)
		if col+w > cols-1 {
			return
		}
		a.crumbs = append(a.crumbs, crumb{x0: col, x1: col + w, n: n})
		if last {
			bc.WriteString(bold + text + reset)
		} else {
			bc.WriteString(cyan + text + reset)
		}
		col += w
	}
	addSeg(" ⌂ "+tabs[a.tab]+" ", nil, len(path) <= 1)
	if len(path) > 1 {
		for i, n := range path {
			bc.WriteString(dim + "›" + reset)
			col++
			lbl := n.label
			if n.name != "" {
				lbl = n.name
			}
			addSeg(" "+strings.TrimRight(fit(lbl, 28), " ")+" ", n, i == len(path)-1)
		}
	}
	o.WriteString(bc.String() + "\x1b[K\r\n")
	o.WriteString(dim + strings.Repeat("─", lw) + "┬" + strings.Repeat("─", max(rw, 0)) + reset + "\x1b[K\r\n")
	a.listTop = 4

	// body
	v := a.visible()
	rows := a.bodyRows()
	sel := a.sel[a.tab]
	if sel < a.off[a.tab] {
		a.off[a.tab] = sel
	}
	if sel >= a.off[a.tab]+rows {
		a.off[a.tab] = sel - rows + 1
	}
	det := a.detailLines()
	maxScroll := len(det) - rows
	if maxScroll < 0 {
		maxScroll = 0
	}
	if a.dscroll > maxScroll {
		a.dscroll = maxScroll
	}
	for r := 0; r < rows; r++ {
		i := a.off[a.tab] + r
		if i < len(v) {
			n := v[i]
			marker := "  "
			if n.expandable() {
				marker = "▸ "
				if n.expanded {
					marker = "▾ "
				}
			}
			ic, col := icon(n.status)
			if n.kind == "Info" && n.status == stNone {
				ic = " "
			}
			prefix := strings.Repeat("  ", n.level) + marker
			lbl := fit(n.label, lw-utf8.RuneCountInString(prefix)-2)
			if i == sel {
				o.WriteString(inverse + prefix + col + ic + reset + inverse + " " + lbl + reset)
			} else {
				o.WriteString(prefix + col + ic + reset + " " + lbl)
			}
		} else {
			o.WriteString(strings.Repeat(" ", lw))
		}
		o.WriteString(dim + "│" + reset)
		if d := a.dscroll + r; d < len(det) && rw > 1 {
			line := " " + fit(det[d], rw-1)
			if d == 0 {
				o.WriteString(bold + line + reset)
			} else {
				o.WriteString(line)
			}
		}
		o.WriteString("\x1b[K\r\n")
	}

	// footer
	m := a.msg
	o.WriteString(dim + strings.Repeat("─", cols) + reset + "\x1b[K\r\n")
	keys := "⏎ expand  esc back  0 top  e events  l logs  f →Claude  u unlock  c ctx  r refresh  ? help  q quit"
	if m != "" {
		o.WriteString(yellow + fit(" "+m, cols) + reset)
	} else {
		o.WriteString(dim + fit(" "+keys, cols) + reset)
	}
	o.WriteString("\x1b[K\x1b[J")
	o.Flush()
}
