package fingerprint

import (
	"context"
	"fmt"
	"sync"
	"time"

	lmfpd "github.com/Ikaleio/lm-detector/sdk/go"
)

// The UI supplies the exact previewed challenges. Sampling and scoring still
// use the SDK; this only replaces Detect's internally generated prompts.
func detectChallenges(ctx context.Context, config lmfpd.DetectConfig, challenges []lmfpd.Challenge, analyze func([]lmfpd.Output, bool) (*lmfpd.Analysis, error)) (*lmfpd.DetectResult, []int64) {
	result := &lmfpd.DetectResult{Challenges: challenges, Samples: make([]lmfpd.Sample, len(challenges))}
	elapsed := make([]int64, len(challenges))
	var workers sync.WaitGroup
	for i, challenge := range challenges {
		workers.Add(1)
		go func() {
			defer workers.Done()
			start := time.Now()
			result.Samples[i] = lmfpd.RequestSample(ctx, config, challenge)
			elapsed[i] = time.Since(start).Milliseconds()
		}()
	}
	workers.Wait()
	outputs := make([]lmfpd.Output, len(challenges))
	accepted := 0
	for i, sample := range result.Samples {
		outputs[i].ExpectedCount = challenges[i].ExpectedCount
		if sample.State == "complete" || sample.State == "truncated" {
			outputs[i].Text = sample.Text
			accepted++
		}
	}
	var reason string
	switch {
	case ctx.Err() != nil:
		reason = "检测已中断，本轮未评分"
	case accepted == 0:
		reason = "未取得有效样本，本轮无法评分"
	case config.Strict && accepted != 3:
		reason = fmt.Sprintf("严格模式需要 3 条有效样本，当前为 %d/3", accepted)
	default:
		analysis, err := analyze(outputs, config.Strict)
		if err != nil {
			reason = err.Error()
		} else {
			result.Analysis = analysis
			if len(analysis.Results) == 0 {
				reason = analysis.Evidence.Reason
			}
		}
	}
	if reason != "" {
		result.Error = &reason
	}
	return result, elapsed
}
