// Package evaluator defines the optional evaluation SDK boundary.
// Engines own their prompts, model calls, and scoring.
package evaluator

import (
	"context"
	"encoding/json"

	"llm-detector/pkg/provider"
)

type Descriptor struct {
	ID                     string   `json:"id"`
	Name                   string   `json:"name"`
	Description            string   `json:"description"`
	Default                bool     `json:"default,omitempty"`
	RequiresExplicitModels bool     `json:"requires_explicit_models,omitempty"`
	Options                []Option `json:"options,omitempty"`
}

type Choice struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// Option supplies the controls for an engine's supported configuration fields.
type Option struct {
	Key     string   `json:"key"`
	Label   string   `json:"label"`
	Kind    string   `json:"kind"` // select or number
	Default any      `json:"default"`
	Choices []Choice `json:"choices,omitempty"`
	Min     int      `json:"min,omitempty"`
	Max     int      `json:"max,omitempty"`
}

type Target struct {
	Provider   provider.Provider
	Connection provider.Connection
	Model      provider.Model
	Options    json.RawMessage
}

// ProviderIndependent marks an engine that performs its own requests from the
// connection, such as a detector supporting several wire protocols.
type ProviderIndependent interface {
	ProviderIndependent() bool
}

// OptionsValidator lets an evaluator reject malformed evaluator-specific
// options at the HTTP boundary, before an asynchronous scan is created.
type OptionsValidator interface {
	ValidateOptions(json.RawMessage) error
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
	Checks  []Check         `json:"checks"`
	Kind    string          `json:"kind,omitempty"`
	Details json.RawMessage `json:"details,omitempty"`
	Error   string          `json:"error,omitempty"`
}

type Engine interface {
	Descriptor() Descriptor
	Run(context.Context, Target) (Report, error)
}
