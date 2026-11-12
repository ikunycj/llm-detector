package fingerprint

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	lmfpd "github.com/Ikaleio/lm-detector/sdk/go"
)

func TestPreviewedChallengesAreSentUnchangedAndKeepSampleFailures(t *testing.T) {
	var mu sync.Mutex
	received := map[string]bool{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-key" {
			t.Error("connection changed")
		}
		var input struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil || len(input.Messages) != 1 {
			t.Error("invalid sample payload")
			return
		}
		prompt := input.Messages[0].Content
		mu.Lock()
		received[prompt] = true
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if prompt == "sample failing" {
			w.WriteHeader(503)
			w.Write([]byte(`{"error":{"message":"fixture-key"}}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]string{"content": strings.Repeat("42 ", 300)}}}})
	}))
	defer upstream.Close()
	challenges := []lmfpd.Challenge{{ID: "one", Prompt: "sample one exact", ExpectedCount: 300}, {ID: "two", Prompt: "sample two exact", ExpectedCount: 300}, {ID: "three", Prompt: "sample failing", ExpectedCount: 300}}
	config := lmfpd.DetectConfig{BaseURL: upstream.URL, API: lmfpd.APIChatCompletions, APIKey: "fixture-key", Model: "fixture-model", Count: 3, NoStream: true, Timeout: time.Second}
	calls := 0
	analyze := func(outputs []lmfpd.Output, strict bool) (*lmfpd.Analysis, error) {
		calls++
		if strict || len(outputs) != 3 || outputs[0].Text == "" || outputs[1].Text == "" || outputs[2].Text != "" {
			t.Fatal("failed sample used for ranking")
		}
		return &lmfpd.Analysis{Decision: "partial", Results: []lmfpd.AnalysisResult{{Model: "fixture"}}}, nil
	}
	result, elapsed := detectChallenges(context.Background(), config, challenges, analyze)
	if calls != 1 || result.Analysis.Decision != "partial" || len(elapsed) != 3 {
		t.Fatal("partial round not analyzed")
	}
	for _, challenge := range challenges {
		if !received[challenge.Prompt] {
			t.Fatal("preview prompt was replaced")
		}
	}
	if result.Samples[0].RawText == "" || result.Samples[0].Count != 300 || result.Samples[2].State != "failed" {
		t.Fatal("sample evidence lost")
	}
	if result.Samples[2].Error == nil || strings.Contains(*result.Samples[2].Error, "fixture-key") {
		t.Fatal("unsafe failure projection")
	}
	config.Strict = true
	result, _ = detectChallenges(context.Background(), config, challenges, analyze)
	if calls != 1 || result.Analysis != nil || result.Error == nil {
		t.Fatal("strict round scored failed samples")
	}
}

func TestChallengeOptionsValidateTheSuppliedRound(t *testing.T) {
	valid := []lmfpd.Challenge{{ID: "one", Prompt: "preview", ExpectedCount: 300}, {ID: "two", Prompt: "second", ExpectedCount: 301}, {ID: "three", Prompt: "third", ExpectedCount: 302}}
	encoded, _ := json.Marshal(map[string]any{"count": 3, "strict": true, "challenges": valid})
	options, err := parseOptions(encoded)
	if err != nil || len(options.Challenges) != 3 || options.Challenges[0].Prompt != "preview" {
		t.Fatalf("preview lost: %v", err)
	}
	invalid := []any{nil, []lmfpd.Challenge{}, valid[:2], append([]lmfpd.Challenge{valid[0]}, valid[:2]...), []lmfpd.Challenge{{ID: "", Prompt: "x", ExpectedCount: 300}}, []lmfpd.Challenge{{ID: "one", Prompt: "", ExpectedCount: 300}}, []lmfpd.Challenge{{ID: "one", Prompt: "x", ExpectedCount: 100000}}}
	for _, value := range invalid {
		encoded, _ := json.Marshal(map[string]any{"count": 3, "challenges": value})
		if _, err := parseOptions(encoded); err == nil {
			t.Fatalf("invalid challenge set accepted: %s", encoded)
		}
	}
	for _, challenge := range []lmfpd.Challenge{{ID: "", Prompt: "x", ExpectedCount: 300}, {ID: "one", Prompt: "", ExpectedCount: 300}, {ID: "one", Prompt: "x", ExpectedCount: 100000}, {ID: "one", Prompt: strings.Repeat("x", 16001), ExpectedCount: 300}} {
		encoded, _ := json.Marshal(map[string]any{"count": 1, "challenges": []lmfpd.Challenge{challenge}})
		if _, err := parseOptions(encoded); err == nil {
			t.Fatal("invalid challenge field accepted")
		}
	}
}
