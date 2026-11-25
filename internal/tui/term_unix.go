//go:build !windows

package tui

import (
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
)

type term struct {
	saved string
}

func stty(args ...string) (string, error) {
	c := exec.Command("stty", args...)
	c.Stdin = os.Stdin
	out, err := c.Output()
	return strings.TrimSpace(string(out)), err
}

func openTerm() (*term, error) {
	saved, err := stty("-g")
	if err != nil {
		return nil, fmt.Errorf("not an interactive terminal (stty failed): %w", err)
	}
	if _, err := stty("raw", "-echo"); err != nil {
		return nil, err
	}
	return &term{saved: saved}, nil
}

func (t *term) restore() { stty(t.saved) }
func (t *term) raw()     { stty("raw", "-echo") }

func termSize() (rows, cols int) {
	out, err := stty("size")
	if err == nil {
		fmt.Sscanf(out, "%d %d", &rows, &cols)
	}
	if rows <= 0 {
		rows = 24
	}
	if cols <= 0 {
		cols = 80
	}
	return
}

func notifyResize(ch chan<- os.Signal) { signal.Notify(ch, syscall.SIGWINCH) }
