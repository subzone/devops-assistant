//go:build windows

package tui

import (
	"errors"
	"os"
)

type term struct{}

func openTerm() (*term, error) {
	return nil, errors.New("the k8sh TUI is not supported on native Windows yet; run it in WSL")
}
func (t *term) restore()               {}
func (t *term) raw()                   {}
func termSize() (int, int)             { return 24, 80 }
func notifyResize(ch chan<- os.Signal) {}
