// Package evaluator defines the optional evaluation SDK boundary.
// Engines own their prompts, model calls, scoring, and benchmark version.
package evaluator

import (
	"context"

	"llm-intelligence/pkg/provider"
)

type Descriptor struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}

type Target struct {
	Provider   provider.Provider
	Connection provider.Connection
	Model      provider.Model
}

type Check struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Status    string `json:"status"` // passed, failed, or error
	LatencyMS int64  `json:"latency_ms"`
	Output    string `json:"output,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Report struct {
	Checks []Check `json:"checks"`
}

type Engine interface {
	Descriptor() Descriptor
	Run(context.Context, Target) (Report, error)
}
