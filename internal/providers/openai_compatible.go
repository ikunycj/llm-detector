package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"llm-intelligence/pkg/provider"
)

type OpenAICompatible struct{ client *http.Client }

func NewOpenAICompatible(timeout time.Duration) *OpenAICompatible {
	return &OpenAICompatible{client: &http.Client{Timeout: timeout,
		// Do not forward credentials through redirects.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}}
}

func (*OpenAICompatible) ID() string   { return "openai-compatible" }
func (*OpenAICompatible) Name() string { return "OpenAI 兼容协议" }

func (p *OpenAICompatible) DiscoverModels(ctx context.Context, conn provider.Connection) ([]provider.Model, error) {
	var response struct {
		Data *[]struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := p.doJSON(ctx, conn, http.MethodGet, "/models", nil, &response); err != nil {
		return nil, err
	}
	if response.Data == nil {
		return nil, errors.New("provider response is missing the models data array")
	}
	models := make([]provider.Model, 0, len(*response.Data))
	seen := make(map[string]bool)
	for _, item := range *response.Data {
		if strings.TrimSpace(item.ID) == "" {
			return nil, errors.New("provider returned an empty model ID")
		}
		if !seen[item.ID] {
			models = append(models, provider.Model{ID: item.ID, Name: item.ID})
			seen[item.ID] = true
		}
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}

func (p *OpenAICompatible) Complete(ctx context.Context, conn provider.Connection, modelID, prompt string) (provider.Completion, error) {
	// Only the common protocol fields are sent. Sampling defaults vary by model.
	request := map[string]any{"model": modelID, "messages": []map[string]string{{"role": "user", "content": prompt}}}
	var response struct {
		Choices []struct {
			Message struct {
				Content *string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	start := time.Now()
	if err := p.doJSON(ctx, conn, http.MethodPost, "/chat/completions", request, &response); err != nil {
		return provider.Completion{}, err
	}
	if len(response.Choices) == 0 || response.Choices[0].Message.Content == nil {
		return provider.Completion{}, errors.New("provider returned no text completion")
	}
	return provider.Completion{Text: *response.Choices[0].Message.Content, LatencyMS: time.Since(start).Milliseconds()}, nil
}

func (p *OpenAICompatible) doJSON(ctx context.Context, conn provider.Connection, method, path string, payload, target any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(conn.BaseURL, "/")+path, body)
	if err != nil {
		return errors.New("cannot construct provider request")
	}
	request.Header.Set("Authorization", "Bearer "+conn.APIKey)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := p.client.Do(request)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return errors.New("provider request timed out")
		}
		if errors.Is(err, context.Canceled) {
			return context.Canceled
		}
		return errors.New("provider connection failed; check URL, network and TLS")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Upstream error bodies may echo credentials; never persist or return them.
		return fmt.Errorf("provider returned HTTP %d", response.StatusCode)
	}
	const maxResponse = 2 << 20
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponse+1))
	if err != nil {
		return errors.New("cannot read provider response")
	}
	if len(data) > maxResponse {
		return errors.New("provider response exceeds 2 MiB")
	}
	if json.Unmarshal(data, target) != nil {
		return errors.New("provider returned an incompatible JSON response")
	}
	return nil
}
