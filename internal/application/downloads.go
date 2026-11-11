package application

import (
	"net/http"
	"path/filepath"
	"regexp"
)

var downloadName = regexp.MustCompile(`^llm-detector-local-(darwin|linux|windows)-(amd64|arm64)\.zip(\.sha256)?$`)

func Downloads(root string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := filepath.Base(r.URL.Path)
		if !downloadName.MatchString(name) {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		http.ServeFile(w, r, filepath.Join(root, name))
	})
}
