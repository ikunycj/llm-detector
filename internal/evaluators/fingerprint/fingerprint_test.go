package fingerprint

import (
	"encoding/json"
	"testing"
	"time"
)

func TestParseOptionsDefaultsAndProtocols(t *testing.T) {
	options, err := parseOptions(nil)
	if err != nil {
		t.Fatal(err)
	}
	if options.API != "chat_completions" || options.Count != 3 || options.Strict || options.TimeoutSeconds != 120 {
		t.Fatalf("unexpected defaults: %+v", options)
	}
	options, err = parseOptions(json.RawMessage(`{}`))
	if err != nil || options.API != "chat_completions" || options.Count != 3 || options.TimeoutSeconds != 120 {
		t.Fatalf("empty object defaults: options=%+v err=%v", options, err)
	}
	for _, api := range []string{"responses", "chat_completions", "messages"} {
		options, err := parseOptions(json.RawMessage(`{"api":"` + api + `","strict":false,"count":2,"timeout_seconds":60}`))
		if err != nil || options.API != api || options.Count != 2 || options.Strict || options.TimeoutSeconds != 60 {
			t.Fatalf("parse %s: options=%+v err=%v", api, options, err)
		}
	}
}

func TestEngineCapsSampleTimeout(t *testing.T) {
	engine := New("", "", 40*time.Second)
	options, err := parseOptions(json.RawMessage(`{"timeout_seconds":120}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := min(time.Duration(options.TimeoutSeconds)*time.Second, engine.requestTimeout); got != 40*time.Second {
		t.Fatalf("request timeout was not capped: %s", got)
	}
}

func TestParseOptionsRejectInvalidConfigurations(t *testing.T) {
	for _, raw := range []string{
		`null`,
		`{"api":"unknown"}`,
		`{"strict":true,"count":2}`,
		`{"count":0}`,
		`{"count":null}`,
		`{"count":4}`,
		`{"timeout_seconds":0}`,
		`{"timeout_seconds":null}`,
		`{"timeout_seconds":3601}`,
		`{"timeout_seconds":-1}`,
		`{"unexpected":true}`,
		`{} {}`,
	} {
		if _, err := parseOptions(json.RawMessage(raw)); err == nil {
			t.Errorf("accepted invalid options: %s", raw)
		}
	}
}
