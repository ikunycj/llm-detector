package config

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestConfiguration(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.WriteFile(".env", []byte("APP_LOGIN_KEY='fixture-file-key'\nSESSION_TTL=2h\nREQUEST_TIMEOUT=15s\n"), 0600); err != nil {
		t.Fatal(err)
	}
	// Inherited command-line keys must not replace the key selected in .env.
	t.Setenv("APP_LOGIN_KEY", "fixture-process-key")
	for _, key := range []string{"HTTP_ADDR", "SESSION_TTL", "REQUEST_TIMEOUT", "WEB_DIST_DIR"} {
		t.Setenv(key, "")
	}
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LoginKey != "fixture-file-key" {
		t.Fatal("login key did not come from .env")
	}
	if cfg.Addr != "127.0.0.1:9001" || cfg.SessionTTL != 2*time.Hour || cfg.RequestTimeout != 15*time.Second {
		t.Fatal("file values or defaults were not applied")
	}
	t.Setenv("HTTP_ADDR", "127.0.0.1:19001")
	t.Setenv("WEB_DIST_DIR", "web/dist")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Addr != "127.0.0.1:19001" || cfg.WebDist != "web/dist" {
		t.Fatal("operational environment overrides were not applied")
	}
	for _, value := range []string{"oops", "0s", "-1s"} {
		t.Setenv("REQUEST_TIMEOUT", value)
		if _, err := Load(); err == nil {
			t.Fatalf("accepted timeout %q", value)
		}
	}
}

func TestRejectMissingOrInvalidEnvFile(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("APP_LOGIN_KEY", "fixture-process-key")
	if _, err := Load(); err == nil {
		t.Fatal("missing .env accepted through an environment key")
	}
	for _, content := range []string{
		"HTTP_ADDR=127.0.0.1:9001\n",
		"APP_LOGIN_KEY=\n",
		"APP_LOGIN_KEY='   '\n",
		"APP_LOGIN_KEY=replace-with-a-long-random-key\n",
		"APP_LOGIN_KEY='fixture-secret-with-invalid-syntax\n",
	} {
		if err := os.WriteFile(".env", []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := Load()
		if err == nil {
			t.Fatal("invalid .env accepted")
		}
		if strings.Contains(err.Error(), "fixture-secret") {
			t.Fatal("configuration error exposed the key")
		}
	}
}
