// user creates cloud accounts from the server console; passwords never enter argv.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"llm-detector/internal/cloud"
	"llm-detector/internal/config"
	"os"
	"strings"
)

func main() {
	username := flag.String("username", "", "new username")
	flag.Parse()
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	db, err := cloud.Open(cfg.DataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot open cloud database")
		os.Exit(1)
	}
	defer db.Close()
	fmt.Fprintln(os.Stderr, "Read password from standard input (not a command-line argument):")
	password, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read password")
		os.Exit(1)
	}
	user, err := db.CreateUser(*username, strings.TrimRight(password, "\r\n"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Created account %s (ID %d)\n", user.Username, user.ID)
}
