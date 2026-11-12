package application

import (
	_ "embed"
	"net/http"
	"path/filepath"
	"regexp"
)

//go:embed install-worker.sh
var workerInstaller []byte

var downloadName = regexp.MustCompile(`^llm-detector-(local|worker)-(darwin|linux|windows)-(amd64|arm64)\.zip(\.sha256)?$`)

func Downloads(root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.URL.Path)
		if name == "install-worker.sh" {
			w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
			w.Header().Set("Content-Disposition", `attachment; filename="install-worker.sh"`)
			w.Write(workerInstaller)
			return
		}
		if !downloadName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		http.ServeFile(w, r, filepath.Join(root, name))
	})
}
