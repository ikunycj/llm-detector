// Package provider is the model transport boundary. It has no SDK dependencies.
package provider

import "context"

type Connection struct {
	BaseURL      string `json:"-"`
	APIKey       string `json:"-"`
	Protocol     string `json:"-"`
	Organization string `json:"-"`
}

type Model struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Completion struct {
	Text      string
	LatencyMS int64
}

type Provider interface {
	ID() string
	Name() string
	DiscoverModels(context.Context, Connection) ([]Model, error)
	Complete(ctx context.Context, connection Connection, modelID, prompt string) (Completion, error)
}
