package cloud

import (
	"bytes"
	"database/sql"
	"errors"
	"llm-detector/internal/scan"
	"llm-detector/pkg/evaluator"
	"llm-detector/pkg/provider"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAccountsPersistenceIsolationAndEncryption(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	alice, err := db.CreateUser("Alice", "fixture-password-alice")
	if err != nil {
		t.Fatal(err)
	}
	bob, err := db.CreateUser("bob", "fixture-password-bob")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err = db.Login("alice", "wrong", time.Hour); !errors.Is(err, ErrCredentials) {
		t.Fatal("accepted wrong password")
	}
	user, token, _, err := db.Login("ALICE", "fixture-password-alice", time.Hour)
	if err != nil || user.ID != alice.ID {
		t.Fatal("account authentication failed")
	}
	secret := []byte(`{"api_key":"fixture-private-api-key"}`)
	if err = db.Put(alice.ID, "model-apis", "shared-id", secret); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Get(bob.ID, "model-apis", "shared-id"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("cross-account read allowed")
	}
	var payload []byte
	var hash string
	if err = db.sql.QueryRow("SELECT payload FROM documents WHERE user_id=?", alice.ID).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(payload, secret) {
		t.Fatal("API secret stored in plaintext")
	}
	if err = db.sql.QueryRow("SELECT password_hash FROM users WHERE id=?", alice.ID).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(hash), []byte("fixture-password-alice")) {
		t.Fatal("password stored in plaintext")
	}
	if err = db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Authenticate("Bearer " + token); err != nil {
		t.Fatal("session not persisted")
	}
	got, err := db.Get(alice.ID, "model-apis", "shared-id")
	if err != nil || !bytes.Equal(got, secret) {
		t.Fatal("configuration did not survive restart")
	}
	if err = db.Logout("Bearer " + token); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Authenticate("Bearer " + token); !errors.Is(err, ErrCredentials) {
		t.Fatal("logout did not revoke session")
	}
}
func TestMissingCloudKeyNeverReplacesEncryptedDatabase(t *testing.T) {
	dir := t.TempDir()
	db, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err = os.Remove(filepath.Join(dir, "cloud.key")); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(dir); err == nil {
		t.Fatal("replaced missing cloud key")
	}
}

func TestShortNonEmptyPasswordIsAccepted(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.CreateUser("short-pass", "ikunycj"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := db.Login("short-pass", "ikunycj", time.Hour); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupLegacyScansRemovesNullChecksOnly(t *testing.T) {
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.CreateUser("legacy-user", "pw"); err != nil {
		t.Fatal(err)
	}
	store := ScanStore{DB: db, UserID: 1}
	if err := store.Save(scan.Scan{ID: "legacy", Status: "completed", Models: []scan.ModelResult{{Model: provider.Model{ID: "old"}, Report: evaluator.Report{Checks: nil}}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(scan.Scan{ID: "current", Status: "completed", Models: []scan.ModelResult{{Model: provider.Model{ID: "new"}, Report: evaluator.Report{Checks: []evaluator.Check{}}}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.CleanupLegacy(); err != nil {
		t.Fatal(err)
	}
	items, err := store.List()
	if err != nil || len(items) != 1 || items[0].ID != "current" {
		t.Fatalf("cleanup result=%+v err=%v", items, err)
	}
}
