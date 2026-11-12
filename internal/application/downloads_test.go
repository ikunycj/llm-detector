package application

import (
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestOnlyLocalRunnerDownloadsAreServed(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"llm-detector-local-linux-amd64.zip", "llm-detector-worker-linux-amd64.zip", "install-worker.sh"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	handler := Downloads(root)
	for _, sample := range []struct {
		name   string
		status int
	}{
		{"llm-detector-local-linux-amd64.zip", 200},
		{"llm-detector-worker-linux-amd64.zip", 404},
		{"install-worker.sh", 404},
	} {
		r := httptest.NewRequest("GET", "/downloads/"+sample.name, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != sample.status {
			t.Fatalf("%s: got %d want %d", sample.name, w.Code, sample.status)
		}
	}
}
