package terminalbench

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type Store interface {
	Load() ([]Job, error)
	Save(Job) error
}
type fileStore struct{ root string }

func (f fileStore) Load() ([]Job, error) {
	entries, err := os.ReadDir(f.root)
	if err != nil {
		return nil, err
	}
	jobs := []Job{}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "tb-") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(f.root, entry.Name(), "job.json"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		var job Job
		if json.Unmarshal(data, &job) != nil || job.ID != entry.Name() {
			return nil, errors.New("Terminal Bench 历史文件损坏")
		}
		jobs = append(jobs, job)
	}
	return jobs, nil
}
func (f fileStore) Save(job Job) error {
	return writeJSONFile(filepath.Join(f.root, job.ID, "job.json"), job)
}

// The service owns the job map and mutex; local persistence is intentionally empty.
type TransientStore struct{}

func (TransientStore) Load() ([]Job, error) { return []Job{}, nil }
func (TransientStore) Save(Job) error       { return nil }
