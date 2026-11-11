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

	"llm-detector/pkg/provider"
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
	start := time.Now()
	protocol := conn.Protocol
	if protocol == "" {
		protocol = "chat_completions"
	}
	switch protocol {
	case "chat_completions":
		request := map[string]any{"model": modelID, "messages": []map[string]string{{"role": "user", "content": prompt}}}
		var response struct {
			Choices []struct {
				Message struct {
					Content *string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := p.doJSON(ctx, conn, http.MethodPost, "/chat/completions", request, &response); err != nil {
			return provider.Completion{}, err
		}
		if len(response.Choices) == 0 || response.Choices[0].Message.Content == nil {
			return provider.Completion{}, errors.New("provider returned no text completion")
		}
		return provider.Completion{Text: *response.Choices[0].Message.Content, LatencyMS: time.Since(start).Milliseconds()}, nil
	case "responses":
		request := map[string]any{"model": modelID, "input": prompt, "store": false}
		var response struct {
			Status     string  `json:"status"`
			OutputText *string `json:"output_text"`
			Output     []struct {
				Type    string `json:"type"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"output"`
		}
		if err := p.doJSON(ctx, conn, http.MethodPost, "/responses", request, &response); err != nil {
			return provider.Completion{}, err
		}
		if response.Status != "completed" {
			return provider.Completion{}, errors.New("provider response did not complete")
		}
		if response.OutputText != nil && strings.TrimSpace(*response.OutputText) != "" {
			return provider.Completion{Text: *response.OutputText, LatencyMS: time.Since(start).Milliseconds()}, nil
		}
		var content strings.Builder
		for _, item := range response.Output {
			if item.Type != "message" {
				continue
			}
			for _, part := range item.Content {
				if part.Type == "output_text" {
					content.WriteString(part.Text)
				}
			}
		}
		if content.Len() == 0 {
			return provider.Completion{}, errors.New("provider returned no text response")
		}
		return provider.Completion{Text: content.String(), LatencyMS: time.Since(start).Milliseconds()}, nil
	case "messages":
		request := map[string]any{"model": modelID, "max_tokens": 4096, "messages": []map[string]any{{"role": "user", "content": prompt}}}
		var response struct {
			Content []struct {
				Type string  `json:"type"`
				Text *string `json:"text"`
			} `json:"content"`
		}
		if err := p.doJSON(ctx, conn, http.MethodPost, "/messages", request, &response); err != nil {
			return provider.Completion{}, err
		}
		var content strings.Builder
		for _, part := range response.Content {
			if part.Type == "text" && part.Text != nil {
				content.WriteString(*part.Text)
			}
		}
		if content.Len() == 0 {
			return provider.Completion{}, errors.New("provider returned no text message")
		}
		return provider.Completion{Text: content.String(), LatencyMS: time.Since(start).Milliseconds()}, nil
	default:
		return provider.Completion{}, errors.New("unsupported provider protocol")
	}
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
	protocol := conn.Protocol
	if protocol == "" {
		protocol = "chat_completions"
	}
	if protocol == "messages" {
		request.Header.Set("x-api-key", conn.APIKey)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+conn.APIKey)
		if conn.Organization != "" {
			request.Header.Set("OpenAI-Organization", conn.Organization)
		}
	}
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
