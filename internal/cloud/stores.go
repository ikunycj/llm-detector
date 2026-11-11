package cloud

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sort"

	"llm-detector/internal/inspection"
	"llm-detector/internal/scan"
	"llm-detector/internal/terminalbench"
)

type ScanStore struct {
	DB     *Database
	UserID int64
}

func (s ScanStore) Save(item scan.Scan) error {
	b, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return s.DB.Put(s.UserID, "scan", item.ID, b)
}
func (s ScanStore) Get(id string) (scan.Scan, error) {
	b, err := s.DB.Get(s.UserID, "scan", id)
	if errors.Is(err, sql.ErrNoRows) {
		return scan.Scan{}, scan.ErrNotFound
	}
	if err != nil {
		return scan.Scan{}, err
	}
	var item scan.Scan
	err = json.Unmarshal(b, &item)
	return item, err
}
func (s ScanStore) List() ([]scan.Scan, error) {
	rows, err := s.DB.List(s.UserID, "scan")
	if err != nil {
		return nil, err
	}
	out := []scan.Scan{}
	for _, b := range rows {
		var item scan.Scan
		if err := json.Unmarshal(b, &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}
func (s ScanStore) CleanupLegacy() error {
	records, err := s.DB.Records(s.UserID, "scan")
	if err != nil {
		return err
	}
	for _, record := range records {
		var item scan.Scan
		if err := json.Unmarshal(record.Data, &item); err != nil {
			if err := s.DB.Delete(s.UserID, "scan", record.ID); err != nil {
				return err
			}
			continue
		}
		legacy := false
		for _, model := range item.Models {
			if model.Report.Checks == nil {
				legacy = true
				break
			}
		}
		if legacy {
			if err := s.DB.Delete(s.UserID, "scan", record.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
func (s ScanStore) Recover() error {
	items, err := s.List()
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.Status == "pending" || item.Status == "running" {
			item.Status = "failed"
			item.Error = "服务重启中断了扫描，不会自动补跑"
			if err := s.Save(item); err != nil {
				return err
			}
		}
	}
	return nil
}

type InspectionStore struct {
	DB     *Database
	UserID int64
}

func (s InspectionStore) Save(item inspection.State) error {
	b, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return s.DB.Put(s.UserID, "inspection", "state", b)
}
func (s InspectionStore) Load() (inspection.State, error) {
	b, err := s.DB.Get(s.UserID, "inspection", "state")
	if errors.Is(err, sql.ErrNoRows) {
		return inspection.EmptyState(), nil
	}
	if err != nil {
		return inspection.State{}, err
	}
	var item inspection.State
	err = json.Unmarshal(b, &item)
	return item, err
}

type BenchStore struct {
	DB     *Database
	UserID int64
}

func (s BenchStore) Save(item terminalbench.Job) error {
	b, err := json.Marshal(item)
	if err != nil {
		return err
	}
	return s.DB.Put(s.UserID, "bench", item.ID, b)
}
func (s BenchStore) Load() ([]terminalbench.Job, error) {
	rows, err := s.DB.List(s.UserID, "bench")
	if err != nil {
		return nil, err
	}
	out := []terminalbench.Job{}
	for _, b := range rows {
		var job terminalbench.Job
		if err := json.Unmarshal(b, &job); err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	return out, nil
}
