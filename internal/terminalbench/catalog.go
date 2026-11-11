package terminalbench

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"
)

//go:embed catalog.json
var catalogData []byte

type Task struct {
	Name   string `json:"name"`
	GitURL string `json:"git_url"`
	Commit string `json:"git_commit_id"`
	Path   string `json:"path"`
}

type Catalog struct {
	Dataset        string   `json:"dataset"`
	RegistrySource string   `json:"registry_source"`
	SourceProject  string   `json:"source_project"`
	HarborVersion  string   `json:"harbor_version"`
	Agent          string   `json:"agent"`
	Daily          []string `json:"daily"`
	Tasks          []Task   `json:"tasks"`
}

func LoadCatalog() (Catalog, error) {
	var catalog Catalog
	if err := json.Unmarshal(catalogData, &catalog); err != nil {
		return catalog, err
	}
	if len(catalog.Tasks) != 89 || len(catalog.Daily) != 6 {
		return catalog, fmt.Errorf("invalid pinned Terminal-Bench manifest")
	}
	for _, name := range catalog.Daily {
		if !slices.ContainsFunc(catalog.Tasks, func(t Task) bool { return t.Name == name }) {
			return catalog, fmt.Errorf("daily task %s missing from full dataset", name)
		}
	}
	return catalog, nil
}
func (c Catalog) Select(suite string) []Task {
	if suite == "full" {
		return slices.Clone(c.Tasks)
	}
	tasks := make([]Task, 0, len(c.Daily))
	for _, name := range c.Daily {
		for _, task := range c.Tasks {
			if task.Name == name {
				tasks = append(tasks, task)
				break
			}
		}
	}
	return tasks
}
