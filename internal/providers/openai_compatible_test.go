package providers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"llm-detector/pkg/provider"
)

func TestProviderMessagesProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "fixture" {
			t.Errorf("x-api-key=%q", r.Header.Get("x-api-key"))
		}
		if r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("anthropic-version=%q", r.Header.Get("anthropic-version"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "claude-test" {
			t.Errorf("model=%v", body["model"])
		}
		json.NewEncoder(w).Encode(map[string]any{"content": []map[string]string{{"type": "text", "text": "hello from messages"}}})
	}))
	defer server.Close()
	result, err := NewOpenAICompatible(time.Second).Complete(context.Background(), provider.Connection{BaseURL: server.URL + "/v1", APIKey: "fixture", Protocol: "messages"}, "claude-test", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello from messages" {
		t.Fatalf("text=%q", result.Text)
	}
}

func TestProviderResponsesProtocol(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" {
			t.Errorf("path=%s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer fixture" {
			t.Errorf("authorization=%q", r.Header.Get("Authorization"))
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["model"] != "gpt-test" || body["input"] != "hello" {
			t.Errorf("request=%v", body)
		}
		json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"type": "message", "content": []map[string]string{{"type": "output_text", "text": "hello from responses"}}}}})
	}))
	defer server.Close()
	result, err := NewOpenAICompatible(time.Second).Complete(context.Background(), provider.Connection{BaseURL: server.URL + "/v1", APIKey: "fixture", Protocol: "responses"}, "gpt-test", "hello")
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "hello from responses" {
		t.Fatalf("text=%q", result.Text)
	}
}

func TestProviderTimeoutAndRedirect(t *testing.T) {
	t.Run("timeout", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { time.Sleep(100 * time.Millisecond) }))
		defer srv.Close()
		p := NewOpenAICompatible(20 * time.Millisecond)
		_, err := p.Complete(context.Background(), provider.Connection{BaseURL: srv.URL, APIKey: "fixture"}, "test", "hello")
		if err == nil || !strings.Contains(err.Error(), "timed out") {
			t.Fatalf("err=%v", err)
		}
	})
	t.Run("redirect", func(t *testing.T) {
		target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("followed redirect with credential") }))
		defer target.Close()
		source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
		defer source.Close()
		_, err := NewOpenAICompatible(time.Second).Complete(context.Background(), provider.Connection{BaseURL: source.URL, APIKey: "fixture"}, "test", "hello")
		if err == nil || !strings.Contains(err.Error(), "307") {
			t.Fatalf("err=%v", err)
		}
	})
}

func TestOrganizationHeaderRespectsTestProtocol(t *testing.T) {
	for _, protocol := range []string{"chat_completions", "responses", "messages"} {
		t.Run(protocol, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if protocol == "chat_completions" || protocol == "responses" {
					if r.Header.Get("OpenAI-Organization") != "org-fixture" || r.Header.Get("Authorization") != "Bearer fixture" {
						t.Error("OpenAI organization or key missing")
					}
					if protocol == "responses" {
						json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output_text": "hello"})
					} else {
						json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]string{"content": "hello"}}}})
					}
				} else {
					if r.Header.Get("OpenAI-Organization") != "" || r.Header.Get("x-api-key") != "fixture" {
						t.Error("Messages authentication contains OpenAI organization or lacks key")
					}
					json.NewEncoder(w).Encode(map[string]any{"content": []any{map[string]string{"type": "text", "text": "hello"}}})
				}
			}))
			defer server.Close()
			_, err := NewOpenAICompatible(time.Second).Complete(context.Background(), provider.Connection{BaseURL: server.URL, APIKey: "fixture", Protocol: protocol, Organization: "org-fixture"}, "model", "hello")
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
