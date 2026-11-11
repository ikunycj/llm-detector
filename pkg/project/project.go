// Package project defines discovery and credential import for managed model projects.
package project

import "context"

type Connection struct {
	BaseURL     string
	AccessToken string
	UserID      int
}

type Channel struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Groups       []string `json:"groups"`
	Tag          string   `json:"tag,omitempty"`
	BaseURL      string   `json:"base_url"`
	Protocol     string   `json:"protocol"`
	Organization string   `json:"organization,omitempty"`
	Models       []string `json:"models"`
	Enabled      bool     `json:"enabled"`
	Issue        string   `json:"issue,omitempty"`
	MultiKey     bool     `json:"multi_key"`
	// Only needed while importing keys; never expose upstream credential payloads.
	KeyStatus map[int]int `json:"-"`
}

type Adapter interface {
	ID() string
	Discover(context.Context, Connection) ([]Channel, error)
	// code is a transient 2FA code. The adapter must not retain it.
	ImportKeys(ctx context.Context, conn Connection, channels []Channel, code string) (map[string]string, map[string]string, error)
}

// IdentityResolver resolves a login name/email through the target's official
// login flow. The password and login OTP are transient and never persisted.
type IdentityResolver interface {
	ResolveUserID(ctx context.Context, connection Connection, account, password, code string) (int, error)
}
