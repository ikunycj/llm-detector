package config

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	Addr           string
	LoginKey       string
	SessionTTL     time.Duration
	RequestTimeout time.Duration
	WebDist        string
}

func Load() (Config, error) {
	values, err := godotenv.Read(".env")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Config{}, fmt.Errorf("cannot load .env: run `make init-env` from the project root")
		}
		// Parser errors may contain the offending line, including a secret.
		return Config{}, fmt.Errorf("cannot load .env: check its permissions and syntax")
	}
	cfg := Config{
		Addr:     env(values, "HTTP_ADDR", "127.0.0.1:9001"),
		LoginKey: values["APP_LOGIN_KEY"],
		WebDist:  env(values, "WEB_DIST_DIR", ""),
	}
	if strings.TrimSpace(cfg.LoginKey) == "" || cfg.LoginKey == "replace-with-a-long-random-key" {
		return Config{}, fmt.Errorf("set APP_LOGIN_KEY to a private development key in .env")
	}
	cfg.SessionTTL, err = duration(values, "SESSION_TTL", "8h")
	if err != nil {
		return Config{}, err
	}
	cfg.RequestTimeout, err = duration(values, "REQUEST_TIMEOUT", "30s")
	if err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Operational settings may be overridden by the process environment. The login
// key deliberately bypasses this helper so every startup uses the same .env key.
func env(values map[string]string, key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	if value := values[key]; value != "" {
		return value
	}
	return fallback
}

func duration(values map[string]string, key, fallback string) (time.Duration, error) {
	value, err := time.ParseDuration(env(values, key, fallback))
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return value, nil
}
