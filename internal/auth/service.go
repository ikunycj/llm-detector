package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strings"
	"sync"
	"time"
)

var ErrInvalidKey = errors.New("invalid login key")

type Service struct {
	key      [32]byte
	ttl      time.Duration
	mu       sync.Mutex
	sessions map[string]time.Time
}

func NewService(key string, ttl time.Duration) *Service {
	return &Service{key: sha256.Sum256([]byte(key)), ttl: ttl, sessions: make(map[string]time.Time)}
}
func (s *Service) Login(key string) (string, time.Time, error) {
	digest := sha256.Sum256([]byte(key))
	if subtle.ConstantTimeCompare(digest[:], s.key[:]) != 1 {
		return "", time.Time{}, ErrInvalidKey
	}
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", time.Time{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(buffer)
	now := time.Now()
	expires := now.Add(s.ttl)
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, expiry := range s.sessions {
		if !now.Before(expiry) {
			delete(s.sessions, token)
		}
	}
	s.sessions[token] = expires
	return token, expires, nil
}
func (s *Service) Authenticate(header string) bool {
	token, ok := strings.CutPrefix(header, "Bearer ")
	if !ok {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	expires, ok := s.sessions[token]
	if !ok || !time.Now().Before(expires) {
		delete(s.sessions, token)
		return false
	}
	return true
}
func (s *Service) Logout(header string) {
	token, _ := strings.CutPrefix(header, "Bearer ")
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}
