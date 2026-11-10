package scan

import (
	"errors"
	"time"

	"llm-intelligence/pkg/evaluator"
	"llm-intelligence/pkg/provider"
)

var ErrNotFound = errors.New("scan not found")

// Request is internal: HTTP validation happens once in httpapi.
type Request struct {
	Vendor     string
	Connection provider.Connection
	Scope      string
	Models     []string
	Evaluator  string
}

type Scan struct {
	ID          string               `json:"id"`
	Status      string               `json:"status"`
	Vendor      string               `json:"vendor"`
	Evaluator   evaluator.Descriptor `json:"evaluator"`
	Scope       string               `json:"scope"`
	Models      []ModelResult        `json:"models"`
	Error       string               `json:"error,omitempty"`
	CreatedAt   time.Time            `json:"created_at"`
	StartedAt   *time.Time           `json:"started_at,omitempty"`
	CompletedAt *time.Time           `json:"completed_at,omitempty"`
}

type ModelResult struct {
	Model  provider.Model   `json:"model"`
	Status string           `json:"status"`
	Report evaluator.Report `json:"report"`
	Error  string           `json:"error,omitempty"`
}

type Store interface {
	Save(Scan)
	Get(string) (Scan, error)
	List() []Scan
}
