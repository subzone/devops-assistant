package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/subzone/devops-assistant/internal/doctor"
)

// runDoctor prints which tools each feature can use and how to get the
// missing ones. It never installs anything: /devops-assistant:setup shows the
// plan and installs only what the user picks, one confirmed command at a time.
func runDoctor(ctx context.Context, args []string) {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	groups := fs.String("group", "", "comma-separated groups (default all): "+groupIDs())
	asJSON := fs.Bool("json", false, "JSON output")
	plan := fs.Bool("plan", false, "print only the install commands for what is missing")
	fs.Parse(args)

	r := doctor.Check(ctx, doctor.DefaultEnv(), doctor.Wanted(*groups))
	switch {
	case *asJSON:
		json.NewEncoder(os.Stdout).Encode(r)
	case *plan:
		for _, c := range doctor.Plan(r) {
			fmt.Println(c)
		}
		for _, it := range doctor.Manual(r) {
			fmt.Printf("# %s: install by hand, see %s\n", it.Name, it.Docs)
		}
	default:
		printDoctor(r)
	}
	if len(r.RequiredMissing) > 0 {
		os.Exit(1)
	}
}

func groupIDs() string {
	ids := []string{}
	for _, g := range doctor.Groups {
		ids = append(ids, g.ID)
	}
	return strings.Join(ids, ",")
}

func printDoctor(r doctor.Report) {
	fmt.Printf("devops-assistant doctor  %s/%s  package managers: %s\n", r.OS, r.Arch, dash(strings.Join(r.Managers, ", ")))
	for _, g := range r.Groups {
		fmt.Printf("\n%s (%s): %d/%d — %s\n", g.Title, g.ID, g.Found, g.Found+g.Missing, g.Why)
		for _, it := range g.Items {
			mark, detail := "✔", it.Version
			if detail == "" {
				detail = it.Path
			}
			if !it.Found {
				mark, detail = "·", it.Install
				if it.Required {
					mark = "✖"
				}
				if detail == "" {
					detail = "see " + it.Docs
				}
			}
			fmt.Printf("  %s %-14s %s\n", mark, it.Name, detail)
		}
	}
	if len(r.RequiredMissing) > 0 {
		fmt.Printf("\n✖ required: %s\n", strings.Join(r.RequiredMissing, ", "))
	}
	fmt.Println("\nNothing was installed. /devops-assistant:setup installs the groups you pick, after you confirm.")
}
