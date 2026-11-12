package cloud

import (
	"bytes"
	"context"
	"encoding/json"
	"llm-detector/internal/config"
	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func call(t *testing.T, h http.Handler, method, path, token string, body any) (int, []byte) {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(data))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w.Code, w.Body.Bytes()
}
func TestCloudRoutesAreAccountScopedAndDoNotReturnKeys(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	alice, err := db.CreateUser("alice", "fixture-alice-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.CreateUser("bob", "fixture-bob-password"); err != nil {
		t.Fatal(err)
	}
	_, a, _, _ := db.Login("alice", "fixture-alice-password", time.Hour)
	_, b, _, _ := db.Login("bob", "fixture-bob-password", time.Hour)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	server, err := NewServer(ctx, config.Config{DataDir: t.TempDir(), RequestTimeout: time.Second, TerminalBenchBinary: "missing-harbor"}, db)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); server.Wait() }()
	if status, _ := call(t, server, "GET", "/api/v1/scans", "", nil); status != 401 {
		t.Fatal("anonymous cloud read allowed")
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer fixture-model-key" {
			t.Error("wrong saved credential or endpoint")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"fixture-model"}]}`))
	}))
	defer upstream.Close()
	input := []ModelAPI{{ID: "api-a", Name: "Alice API", Vendor: "openai-compatible", BaseURL: upstream.URL + "/v1", Protocol: "chat_completions", APIKey: "fixture-model-key", Scope: "all", Models: []string{}, UpdatedAt: "now"}}
	status, data := call(t, server, "PUT", "/api/v1/model-services", a, input)
	if status != 200 || bytes.Contains(data, []byte("fixture-model-key")) {
		t.Fatalf("save status=%d exposed secret=%v", status, bytes.Contains(data, []byte("fixture-model-key")))
	}
	status, data = call(t, server, "GET", "/api/v1/model-services", b, nil)
	if status != 200 || bytes.Contains(data, []byte("api-a")) {
		t.Fatal("cross-account configuration leak")
	}
	status, _ = call(t, server, "POST", "/api/v1/models/discover", b, map[string]any{"service_id": "api-a"})
	if status != 404 || calls != 0 {
		t.Fatal("other account used saved key")
	}
	status, _ = call(t, server, "POST", "/api/v1/models/discover", a, map[string]any{"service_id": "api-a", "base_url": "https://attacker.invalid"})
	if status != 200 || calls != 1 {
		t.Fatal("saved API credential resolution failed")
	}

	status, data = call(t, server, "POST", "/api/v1/model-services/transfer", b, map[string]string{"id": "api-a"})
	if status != 404 || bytes.Contains(data, []byte("fixture-model-key")) {
		t.Fatal("cross-account transfer leaked key")
	}
	status, data = call(t, server, "POST", "/api/v1/model-services/transfer", a, map[string]string{"id": "api-a"})
	if status != 200 || !bytes.Contains(data, []byte("fixture-model-key")) {
		t.Fatal("owner's explicit transfer failed")
	}
	input[0].APIKey = ""
	input[0].Name = "Renamed"
	if status, _ = call(t, server, "PUT", "/api/v1/model-services", a, input); status != 200 {
		t.Fatal("blank edit did not retain key")
	}
	services, err := server.loadServices(alice.ID)
	if err != nil || services[0].APIKey != "fixture-model-key" {
		t.Fatal("saved key was erased")
	}
	store := ScanStore{db, alice.ID}
	if err = store.Save(scan.Scan{ID: "private-scan", Status: "completed", Evaluator: evaluator.Descriptor{ID: "fingerprint"}}); err != nil {
		t.Fatal(err)
	}
	if status, _ = call(t, server, "GET", "/api/v1/scans/private-scan", b, nil); status != 404 {
		t.Fatal("cross-account scan read allowed")
	}
	if status, _ = call(t, server, "GET", "/api/v1/scans/private-scan", a, nil); status != 200 {
		t.Fatal("owner cannot read scan")
	}
	status, data = call(t, server, "POST", "/api/v1/inspection/projects", a, map[string]any{"name": "Private project", "kind": "newapi", "base_url": "https://fixture.invalid", "user_id": 1, "access_token": "fixture-admin-key"})
	if status != 201 {
		t.Fatalf("create project status %d", status)
	}
	var project struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(data, &project) != nil {
		t.Fatal("invalid project response")
	}
	status, data = call(t, server, "POST", "/api/v1/inspection/projects/"+project.ID+"/transfer", b, nil)
	if status != 404 || bytes.Contains(data, []byte("fixture-admin-key")) {
		t.Fatal("cross-account project transfer leaked credentials")
	}
	status, data = call(t, server, "POST", "/api/v1/inspection/projects/"+project.ID+"/transfer", a, nil)
	if status != 200 || !bytes.Contains(data, []byte("fixture-admin-key")) {
		t.Fatal("owner cannot explicitly transfer project")
	}
	if status, _ = call(t, server, "DELETE", "/api/v1/inspection/projects/"+project.ID, b, nil); status != 404 {
		t.Fatal("cross-account project deletion allowed")
	}
}

func TestCloudKeyLoginKeepsConfiguredOwnerAndSessionLifetime(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.CreateUser("other", "other-password"); err != nil {
		t.Fatal(err)
	}
	owner, err := db.CreateUser("owner", "password-unused-by-http-login")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Put(owner.ID, "model-apis", "all", []byte(`[{"id":"existing-api","name":"Existing API","api_key":"private-model-key"}]`)); err != nil {
		t.Fatal(err)
	}
	key := "fixture-cloud-access-key"
	server := &Server{db: db, cfg: config.Config{CloudAdminUsername: "owner", CloudLoginKey: key, SessionTTL: 24 * time.Hour}, attempts: map[string][]time.Time{}}
	handler := http.HandlerFunc(server.Login)
	for _, invalid := range []map[string]string{{"key": ""}, {"key": "wrong"}, {"password": "password-unused-by-http-login", "username": "owner"}, {"key": key, "username": "other"}} {
		status, body := call(t, handler, "POST", "/api/v1/auth/login", "", invalid)
		if status != 401 && status != 400 {
			t.Fatalf("invalid key payload accepted: %d", status)
		}
		if bytes.Contains(body, []byte(key)) {
			t.Fatal("error exposed key")
		}
	}
	status, body := call(t, handler, "POST", "/api/v1/auth/login", "", map[string]string{"key": key})
	if status != 200 {
		t.Fatalf("key login status=%d", status)
	}
	if bytes.Contains(body, []byte(key)) {
		t.Fatal("login response echoed static key")
	}
	var session struct {
		User    User      `json:"user"`
		Token   string    `json:"token"`
		Expires time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &session); err != nil {
		t.Fatal(err)
	}
	if session.User.ID != owner.ID || session.Token == "" || session.Token == key {
		t.Fatal("key did not resolve to configured existing account")
	}
	if ttl := time.Until(session.Expires); ttl < 24*time.Hour-2*time.Second || ttl > 24*time.Hour {
		t.Fatalf("wrong session ttl: %v", ttl)
	}
	if user, err := db.Authenticate("Bearer " + session.Token); err != nil || user.ID != owner.ID {
		t.Fatal("session is not usable")
	}
	status, body = call(t, server, "GET", "/api/v1/model-services", session.Token, nil)
	if status != 200 || !bytes.Contains(body, []byte("existing-api")) || bytes.Contains(body, []byte("private-model-key")) {
		t.Fatal("existing owner data unavailable or unredacted")
	}
	if status, _ = call(t, server, "POST", "/api/v1/auth/logout", session.Token, nil); status != 204 {
		t.Fatal("logout failed")
	}
	if status, _ = call(t, server, "GET", "/api/v1/auth/me", session.Token, nil); status != 401 {
		t.Fatal("revoked session accepted")
	}
	server.cfg.CloudLoginKey = ""
	if status, _ = call(t, handler, "POST", "/api/v1/auth/login", "", map[string]string{"key": ""}); status != 401 {
		t.Fatal("empty configured key accepted")
	}
}
