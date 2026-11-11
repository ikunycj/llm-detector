package inspection

import (
	"maps"
	"slices"
	"time"
)

// Snapshots never share mutable slices or pointers with workers or API callers.
func cloneState(value state) state {
	copy := value
	copy.Projects = maps.Clone(value.Projects)
	for id, raw := range copy.Projects {
		raw.Keys = maps.Clone(raw.Keys)
		raw.View.Groups = slices.Clone(raw.View.Groups)
		raw.View.SyncedAt = cloneTime(raw.View.SyncedAt)
		raw.View.NextRunAt = cloneTime(raw.View.NextRunAt)
		raw.View.Plan.Groups = slices.Clone(raw.View.Plan.Groups)
		raw.View.Plan.ChannelIDs = slices.Clone(raw.View.Plan.ChannelIDs)
		raw.View.Plan.Models = slices.Clone(raw.View.Plan.Models)
		raw.View.Plan.Evaluators = slices.Clone(raw.View.Plan.Evaluators)
		raw.View.Plan.EvaluatorOptions = maps.Clone(raw.View.Plan.EvaluatorOptions)
		for key, options := range raw.View.Plan.EvaluatorOptions {
			raw.View.Plan.EvaluatorOptions[key] = slices.Clone(options)
		}
		raw.View.Channels = slices.Clone(raw.View.Channels)
		for i := range raw.View.Channels {
			channel := &raw.View.Channels[i]
			channel.Groups = slices.Clone(channel.Groups)
			channel.Models = slices.Clone(channel.Models)
			channel.KeyStatus = maps.Clone(channel.KeyStatus)
		}
		copy.Projects[id] = raw
	}
	copy.Runs = slices.Clone(value.Runs)
	for i := range copy.Runs {
		run := &copy.Runs[i]
		run.CompletedAt = cloneTime(run.CompletedAt)
		run.Items = slices.Clone(run.Items)
		for j := range run.Items {
			item := &run.Items[j]
			item.Groups = slices.Clone(item.Groups)
			item.Models = slices.Clone(item.Models)
			if item.Result != nil {
				result := *item.Result
				result.StartedAt = cloneTime(result.StartedAt)
				result.CompletedAt = cloneTime(result.CompletedAt)
				result.Models = slices.Clone(result.Models)
				for k := range result.Models {
					model := &result.Models[k]
					model.Report.Checks = slices.Clone(model.Report.Checks)
					model.Report.Details = slices.Clone(model.Report.Details)
				}
				item.Result = &result
			}
		}
	}
	return copy
}

func cloneTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
