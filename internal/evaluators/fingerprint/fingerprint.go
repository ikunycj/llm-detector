package fingerprint

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	lmfpd "github.com/Ikaleio/lm-detector/sdk/go"

	"llm-detector/pkg/evaluator"
)

const (
	ID = "fingerprint"
)

type Options struct {
	API            string            `json:"api"`
	Strict         bool              `json:"strict"`
	Count          int               `json:"count"`
	TimeoutSeconds int               `json:"timeout_seconds"`
	Challenges     []lmfpd.Challenge `json:"challenges,omitempty"`
}

type Candidate struct {
	Model       string   `json:"model"`
	DisplayName string   `json:"display_name"`
	Family      string   `json:"family"`
	FamilyName  string   `json:"family_name"`
	Score       float64  `json:"score"`
	Probability *float64 `json:"probability"`
}

type Sample struct {
	ChallengeID     string  `json:"challenge_id"`
	Prompt          string  `json:"prompt,omitempty"`
	Output          string  `json:"output"`
	OutputTruncated bool    `json:"output_truncated,omitempty"`
	ElapsedMS       *int64  `json:"elapsed_ms,omitempty"`
	ExpectedCount   int     `json:"expected_count"`
	State           string  `json:"state"`
	Count           int     `json:"count"`
	FirstByteMS     *int64  `json:"first_byte_ms"`
	ResponseModel   *string `json:"response_model"`
	Error           *string `json:"error"`
}

type Details struct {
	Decision          string             `json:"decision,omitempty"`
	Prediction        string             `json:"prediction,omitempty"`
	PredictionName    string             `json:"prediction_name,omitempty"`
	FamilyPrediction  string             `json:"family_prediction,omitempty"`
	FamilyName        string             `json:"family_prediction_name,omitempty"`
	Probability       *float64           `json:"probability"`
	ProbabilityStatus string             `json:"probability_status,omitempty"`
	ProbabilityScope  *string            `json:"probability_scope"`
	RankingScore      *float64           `json:"ranking_score"`
	Candidates        []Candidate        `json:"candidates"`
	Samples           []Sample           `json:"samples"`
	ReferenceBuiltAt  string             `json:"reference_built_at"`
	ModelVersion      lmfpd.ModelVersion `json:"model_version"`
	Evidence          *lmfpd.Evidence    `json:"evidence"`
	Error             string             `json:"error,omitempty"`
	Disclaimer        string             `json:"disclaimer"`
}

type Engine struct {
	dataSources    []string
	cachePath      string
	requestTimeout time.Duration
	mu             sync.Mutex
	detector       *lmfpd.Detector
}

func New(dataSource, cachePath string, requestTimeout time.Duration) *Engine {
	var sources []string
	if strings.TrimSpace(dataSource) != "" {
		sources = []string{strings.TrimSpace(dataSource)}
	}
	if requestTimeout <= 0 {
		requestTimeout = 120 * time.Second
	}
	return &Engine{dataSources: sources, cachePath: strings.TrimSpace(cachePath), requestTimeout: requestTimeout}
}

func (Engine) Descriptor() evaluator.Descriptor {
	return evaluator.Descriptor{
		ID:                     ID,
		Name:                   "Fingerpoint 指纹检测",
		Description:            "以随机整数回答识别参考库内最相似的模型候选；不是身份认证或智力评分。",
		Default:                true,
		RequiresExplicitModels: true,
		Options: []evaluator.Option{
			{Key: "count", Label: "样本数量", Kind: "number", Default: 3, Min: 1, Max: 3},
			{Key: "timeout_seconds", Label: "请求超时（秒）", Kind: "number", Default: 120, Min: 1, Max: 3600},
		},
	}
}

func (Engine) ProviderIndependent() bool { return true }

func (Engine) ValidateOptions(raw json.RawMessage) error {
	_, err := parseOptions(raw)
	return err
}

func (e *Engine) Run(ctx context.Context, target evaluator.Target) (reportOut evaluator.Report, runErr error) {
	options, err := parseOptions(target.Options)
	if err != nil {
		return evaluator.Report{}, err
	}
	detector, err := e.load(ctx)
	if err != nil {
		return evaluator.Report{}, fmt.Errorf("load Fingerpoint reference data: %w", err)
	}
	api := lmfpd.API(options.API)
	config := lmfpd.DetectConfig{
		BaseURL: target.Connection.BaseURL,
		APIKey:  target.Connection.APIKey,
		Model:   target.Model.ID,
		API:     api,
		Count:   options.Count,
		Strict:  options.Strict,
		Timeout: min(time.Duration(options.TimeoutSeconds)*time.Second, e.requestTimeout),
	}
	if target.Connection.Organization != "" && api != lmfpd.APIMessages {
		baseURL, stop, err := organizationEndpoint(ctx, config, target.Connection.Organization)
		if err != nil {
			return evaluator.Report{}, err
		}
		defer func() { runErr = errors.Join(runErr, stop()) }()
		config.BaseURL = baseURL
	}
	var result *lmfpd.DetectResult
	var elapsed []int64
	if len(options.Challenges) > 0 {
		result, elapsed = detectChallenges(ctx, config, options.Challenges, detector.Analyze)
	} else {
		result, err = detector.Detect(ctx, config)
	}
	if err != nil {
		return evaluator.Report{}, fmt.Errorf("start Fingerpoint detection: %w", err)
	}
	details := Details{
		Candidates:       []Candidate{},
		Samples:          make([]Sample, 0, len(result.Samples)),
		ReferenceBuiltAt: detector.BuiltAt(),
		Disclaimer:       "候选来自封闭参考库；库外模型也会被映射到最相似候选。排名与概率不是身份确认，请结合固定参数和多轮检测判断。",
	}
	if result.Error != nil {
		details.Error = strings.ReplaceAll(*result.Error, target.Connection.APIKey, "[REDACTED]")
	}
	for index, sample := range result.Samples {
		item := Sample{State: sample.State, Count: sample.Count, ExpectedCount: sample.ExpectedCount, FirstByteMS: sample.FirstByteMs}
		output := sample.RawText
		if output == "" {
			output = sample.Text
		}
		// Keep bounded, redacted evidence for the sample cards, never in logs.
		runes := []rune(strings.ReplaceAll(output, target.Connection.APIKey, "[REDACTED]"))
		item.OutputTruncated = len(runes) > 16384
		item.Output = string(runes[:min(len(runes), 16384)])
		if elapsed != nil {
			item.ElapsedMS = &elapsed[index]
		}
		if sample.ResponseModel != nil {
			value := strings.ReplaceAll(*sample.ResponseModel, target.Connection.APIKey, "[REDACTED]")
			item.ResponseModel = &value
		}
		if index < len(result.Challenges) {
			item.ChallengeID = result.Challenges[index].ID
			item.Prompt = result.Challenges[index].Prompt
		}
		if sample.Error != nil {
			value := strings.ReplaceAll(*sample.Error, target.Connection.APIKey, "[REDACTED]")
			item.Error = &value
		}
		details.Samples = append(details.Samples, item)
	}
	if result.Analysis != nil {
		analysis := result.Analysis
		details.Decision = analysis.Decision
		details.Prediction = analysis.Prediction
		details.PredictionName = analysis.PredictionName
		details.FamilyPrediction = analysis.FamilyPrediction
		details.FamilyName = analysis.FamilyPredictionName
		details.Probability = analysis.Probability
		details.ProbabilityStatus = analysis.ProbabilityStatus
		details.ProbabilityScope = analysis.ProbabilityScope
		details.RankingScore = analysis.RankingScore
		details.ModelVersion = analysis.ModelVersion
		details.Evidence = &analysis.Evidence
		for _, candidate := range analysis.Results {
			details.Candidates = append(details.Candidates, Candidate{
				Model: candidate.Model, DisplayName: candidate.DisplayName,
				Family: candidate.Family, FamilyName: candidate.FamilyName,
				Score: candidate.Score, Probability: candidate.Probability,
			})
		}
	}
	encoded, err := json.Marshal(details)
	if err != nil {
		return evaluator.Report{}, fmt.Errorf("encode Fingerpoint result: %w", err)
	}
	return evaluator.Report{
		Kind:    ID,
		Details: encoded,
	}, nil
}

func (e *Engine) load(ctx context.Context) (*lmfpd.Detector, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.detector != nil {
		return e.detector, nil
	}
	options := lmfpd.LoadOptions{}
	if len(e.dataSources) > 0 {
		options.Sources = e.dataSources
	}
	if e.cachePath != "" {
		options.Cache = e.cachePath
	}
	detector, err := lmfpd.Load(ctx, options)
	if err != nil {
		return nil, err
	}
	if detector == nil {
		return nil, errors.New("SDK returned an empty detector")
	}
	e.detector = detector
	return detector, nil
}

func parseOptions(raw json.RawMessage) (Options, error) {
	options := Options{API: string(lmfpd.APIChatCompletions), Count: 3, TimeoutSeconds: 120}
	if len(raw) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		var supplied *Options
		if err := decoder.Decode(&supplied); err != nil || supplied == nil {
			return Options{}, errors.New("fingerprint options must be a JSON object")
		}
		if err := decoder.Decode(&struct{}{}); err != io.EOF {
			return Options{}, errors.New("fingerprint options must contain one JSON object")
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			return Options{}, errors.New("fingerprint options must be a JSON object")
		}
		if _, ok := fields["count"]; ok && supplied.Count == 0 {
			return Options{}, errors.New("fingerprint count must be from 1 to 3")
		}
		if _, ok := fields["timeout_seconds"]; ok && supplied.TimeoutSeconds == 0 {
			return Options{}, errors.New("fingerprint timeout_seconds must be from 1 to 3600")
		}
		if challenges, ok := fields["challenges"]; ok {
			if string(challenges) == "null" || len(supplied.Challenges) == 0 {
				return Options{}, errors.New("fingerprint challenges must contain 1 to 3 prompts")
			}
			options.Challenges = supplied.Challenges
		}
		if supplied.API != "" {
			options.API = supplied.API
		}
		if supplied.Count != 0 {
			options.Count = supplied.Count
		}
		options.Strict = supplied.Strict
		if supplied.TimeoutSeconds != 0 {
			options.TimeoutSeconds = supplied.TimeoutSeconds
		}
	}
	switch options.API {
	case string(lmfpd.APIResponses), string(lmfpd.APIChatCompletions), string(lmfpd.APIMessages):
	default:
		return Options{}, errors.New("fingerprint api must be responses, chat_completions, or messages")
	}
	if options.Count == 0 {
		options.Count = 3
	}
	if options.Count < 1 || options.Count > 3 {
		return Options{}, errors.New("fingerprint count must be from 1 to 3")
	}
	if options.Strict && options.Count != 3 {
		return Options{}, errors.New("strict fingerprint detection requires 3 samples")
	}
	if options.Challenges != nil {
		if len(options.Challenges) != options.Count {
			return Options{}, errors.New("fingerprint challenges must match count")
		}
		ids := map[string]bool{}
		for _, challenge := range options.Challenges {
			if strings.TrimSpace(challenge.ID) == "" || len(challenge.ID) > 128 || ids[challenge.ID] {
				return Options{}, errors.New("fingerprint challenge IDs must be nonempty and unique")
			}
			if strings.TrimSpace(challenge.Prompt) == "" || len(challenge.Prompt) > 16000 || challenge.ExpectedCount < 292 || challenge.ExpectedCount > 332 {
				return Options{}, errors.New("fingerprint challenge prompt or expected_count is invalid")
			}
			ids[challenge.ID] = true
		}
	}
	if options.TimeoutSeconds == 0 {
		options.TimeoutSeconds = 120
	}
	if options.TimeoutSeconds < 1 || options.TimeoutSeconds > 3600 {
		return Options{}, errors.New("fingerprint timeout_seconds must be from 1 to 3600")
	}
	return options, nil
}
