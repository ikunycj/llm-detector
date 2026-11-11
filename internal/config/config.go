package config

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	DataDir                   string
	TerminalBenchBinary       string
	Addr                      string
	CloudAdminUsername        string
	CloudAdminPassword        string
	SessionTTL                time.Duration
	RequestTimeout            time.Duration
	WebDist                   string
	FingerprintDataSource     string
	FingerprintCachePath      string
	FingerprintRequestTimeout time.Duration
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
		DataDir:               env(values, "DATA_DIR", "data"),
		TerminalBenchBinary:   env(values, "TERMINAL_BENCH_BINARY", "extensions/terminal-bench/.venv/bin/harbor"),
		Addr:                  env(values, "HTTP_ADDR", "127.0.0.1:9001"),
		CloudAdminUsername:    values["CLOUD_ADMIN_USERNAME"],
		CloudAdminPassword:    values["CLOUD_ADMIN_PASSWORD"],
		WebDist:               env(values, "WEB_DIST_DIR", ""),
		FingerprintDataSource: env(values, "FINGERPRINT_DATA_SOURCE", ""),
		FingerprintCachePath:  env(values, "FINGERPRINT_CACHE_PATH", ""),
	}
	cfg.SessionTTL, err = duration(values, "SESSION_TTL", "24h")
	if err != nil {
		return Config{}, err
	}
	cfg.RequestTimeout, err = duration(values, "REQUEST_TIMEOUT", "30s")
	if err != nil {
		return Config{}, err
	}
	cfg.FingerprintRequestTimeout, err = duration(values, "FINGERPRINT_REQUEST_TIMEOUT", "120s")
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
