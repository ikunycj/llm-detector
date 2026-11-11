package localruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalConnectionOriginsMemoryStorageAndCleanup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	local, err := New(ctx, t.TempDir(), "https://fixture.example")
	if err != nil {
		t.Fatal(err)
	}
	defer local.Close()
	call := func(method, path, origin, host, token string, input any) (int, []byte) {
		data, _ := json.Marshal(input)
		r := httptest.NewRequest(method, path, bytes.NewReader(data))
		r.Host = host
		r.Header.Set("Origin", origin)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		local.ServeHTTP(w, r)
		return w.Code, w.Body.Bytes()
	}
	origin := "https://fixture.example"
	host := "127.0.0.1:9002"
	if status, _ := call("GET", "/healthz", origin, "evil.example:9002", "", nil); status != 403 {
		t.Fatal("DNS rebinding host accepted")
	}
	if status, _ := call("POST", "/api/v1/local/connect", "https://other.example", host, "", nil); status != 403 {
		t.Fatal("unlisted page origin connected to local runtime")
	}
	status, data := call("POST", "/api/v1/local/connect", origin, host, "", nil)
	if status != 200 {
		t.Fatal("local pairing failed")
	}
	var session struct {
		Token string `json:"token"`
	}
	json.Unmarshal(data, &session)
	if status, _ = call("GET", "/api/v1/local/state", "https://other.example", host, session.Token, nil); status != 401 {
		t.Fatal("token usable from a different page origin")
	}
	status, _ = call("POST", "/api/v1/inspection/projects", origin, host, session.Token, map[string]any{"name": "Local project", "kind": "newapi", "base_url": "https://fixture.invalid", "user_id": 1, "access_token": "local-fixture-secret"})
	if status != 201 {
		t.Fatalf("local project create=%d", status)
	}
	status, data = call("GET", "/api/v1/local/state", origin, host, session.Token, nil)
	if status != 200 || !bytes.Contains(data, []byte("local-fixture-secret")) {
		t.Fatal("browser cannot save local project credentials")
	}
	files := 0
	filepath.WalkDir(local.Root, func(_ string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			files++
		}
		return err
	})
	if files != 0 {
		t.Fatal("local project state was written outside browser")
	}
	if status, _ = call("PUT", "/api/v1/inspection/projects/any/plan", origin, host, session.Token, map[string]any{"enabled": true}); status != 400 {
		t.Fatal("local server scheduling was allowed")
	}
	if status, _ = call("DELETE", "/api/v1/local/session", origin, host, session.Token, nil); status != 204 {
		t.Fatal("local session cleanup failed")
	}
	if status, _ = call("GET", "/api/v1/local/state", origin, host, session.Token, nil); status != 401 {
		t.Fatal("disconnected token still worked")
	}
}
