package smoke

import (
	"context"
	"encoding/json"
	"strings"

	"llm-detector/pkg/evaluator"
)

type Engine struct{}

func (Engine) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{ID: "smoke", Name: "基础巡检", Description: "可用性、精确指令跟随与 JSON 输出；不代表通用智力基准。", Default: true}
}

func (Engine) Run(ctx context.Context, target evaluator.Target) (evaluator.Report, error) {
	cases := []struct {
		id, name, prompt string
		validate         func(string) bool
	}{
		{"availability", "可用性", "Say hello briefly.", func(s string) bool { return strings.TrimSpace(s) != "" }},
		{"instruction-following", "精确指令跟随", "Reply with exactly the single character: 4", func(s string) bool { return strings.TrimSpace(s) == "4" }},
		{"structured-output", "JSON 输出", `Return only this JSON object: {"status":"ok"}`, validJSON},
	}
	report := evaluator.Report{Checks: make([]evaluator.Check, 0, len(cases))}
	for _, test := range cases {
		if err := ctx.Err(); err != nil {
			return report, err
		}
		check := evaluator.Check{ID: test.id, Name: test.name}
		result, err := target.Provider.Complete(ctx, target.Connection, target.Model.ID, test.prompt)
		if err != nil {
			check.Status, check.Error = "error", err.Error()
		} else {
			check.Status = "failed"
			if test.validate(result.Text) {
				check.Status = "passed"
			}
			check.Output, check.LatencyMS = result.Text, result.LatencyMS
		}
		report.Checks = append(report.Checks, check)
	}
	return report, nil
}

func validJSON(text string) bool {
	var value map[string]json.RawMessage
	if json.Unmarshal([]byte(text), &value) != nil || len(value) != 1 {
		return false
	}
	var status string
	return json.Unmarshal(value["status"], &status) == nil && status == "ok"
}
