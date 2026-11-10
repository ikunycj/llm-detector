package auth

import (
	"errors"
	"testing"
	"time"
)

func TestSessionLifecycle(t *testing.T) {
	s := NewService("fixture-login-key", time.Hour)
	if _, _, err := s.Login("wrong"); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("wrong key: %v", err)
	}
	token, expires, err := s.Login("fixture-login-key")
	if err != nil || token == "" || !expires.After(time.Now()) {
		t.Fatalf("login: %v", err)
	}
	if s.Authenticate("Bearer fixture-login-key") {
		t.Fatal("deployment key accepted as session token")
	}
	if !s.Authenticate("Bearer " + token) {
		t.Fatal("session not authenticated")
	}
	s.Logout("Bearer " + token)
	if s.Authenticate("Bearer " + token) {
		t.Fatal("logout did not revoke session")
	}
	expired := NewService("fixture-login-key", -time.Second)
	token, _, err = expired.Login("fixture-login-key")
	if err != nil {
		t.Fatal(err)
	}
	if expired.Authenticate("Bearer " + token) {
		t.Fatal("expired session accepted")
	}
}
