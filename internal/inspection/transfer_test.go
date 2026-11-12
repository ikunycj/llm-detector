package inspection

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestProjectTransferCopiesKeysAndDisablesSchedule(t *testing.T) {
	source, _, _, _ := setupService(t)
	original := configureService(t, source)
	transferred, err := source.Export(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	if transferred.AccessToken != "fixture-admin-secret" || transferred.Keys["1"] != "fixture-upstream-secret" {
		t.Fatal("transfer did not include required credentials")
	}
	destination, _, runner, _ := setupService(t)
	copy, err := destination.Import(transferred)
	if err != nil {
		t.Fatal(err)
	}
	if copy.ID == original.ID || copy.Plan.Enabled || copy.NextRunAt != nil || !copy.Channels[0].HasKey {
		t.Fatal("copy identity, keys or schedule incorrect")
	}
	before, err := source.Get(original.ID)
	if err != nil || !before.Plan.Enabled {
		t.Fatal("copy mutated original")
	}
	encoded, _ := json.Marshal(copy)
	if strings.Contains(string(encoded), "fixture-admin-secret") || strings.Contains(string(encoded), "fixture-upstream-secret") {
		t.Fatal("public project leaked credentials")
	}
	// Execution on destination uses transferred keys, without contacting a real upstream.
	close(runner.gate)
	run, err := destination.Run(copy.ID, "manual")
	if err != nil {
		t.Fatal(err)
	}
	destination.Wait()
	got, err := destination.Runs(copy.ID)
	if err != nil || len(got) != 1 || got[0].ID != run.ID {
		t.Fatal("destination run missing")
	}
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if len(runner.requests) == 0 || runner.requests[0].Connection.APIKey != "fixture-upstream-secret" {
		t.Fatal("destination did not use transferred channel key")
	}
	if _, err := source.Export("missing"); err != ErrNotFound {
		t.Fatal("missing project transfer must fail")
	}
}

func TestProjectTransferRejectsInvalidCredentialsAndChannelIDs(t *testing.T) {
	s, _, _, _ := setupService(t)
	p := configureService(t, s)
	transfer, err := s.Export(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	transfer.AccessToken = "bad\nheader"
	if _, err = s.Import(transfer); err == nil {
		t.Fatal("invalid token accepted")
	}
	transfer, err = s.Export(p.ID)
	if err != nil {
		t.Fatal(err)
	}
	transfer.View.Channels[1].ID = transfer.View.Channels[0].ID
	if _, err = s.Import(transfer); err == nil {
		t.Fatal("duplicate channels accepted")
	}
}
