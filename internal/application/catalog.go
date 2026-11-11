package application

import (
	"encoding/json"
	"llm-detector/internal/evaluators/fingerprint"
	benchevaluator "llm-detector/internal/evaluators/terminalbench"
	"llm-detector/internal/terminalbench"
	"llm-detector/pkg/evaluator"
	"net/http"
)

func writeCatalog(w http.ResponseWriter, catalog terminalbench.Catalog) {
	json.NewEncoder(w).Encode(map[string]any{"providers": []map[string]string{{"id": "openai-compatible", "name": "OpenAI 兼容协议"}}, "evaluators": []evaluator.Descriptor{fingerprint.New("", "", 0).Descriptor(), benchevaluator.New(nil).Descriptor()}, "terminal_bench": catalog})
}
