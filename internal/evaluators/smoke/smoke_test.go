package smoke

import "testing"

func TestStrictJSONCheck(t *testing.T) {
	for _, test := range []struct {
		input string
		want  bool
	}{
		{`{"status":"ok"}`, true}, {" \n{\"status\":\"ok\"}\n", true},
		{`{"status":"ok","extra":true}`, false}, {`{"status":4}`, false},
		{"```json\n{\"status\":\"ok\"}\n```", false}, {`null`, false}, {`{"status":"ok"} trailing`, false},
	} {
		if got := validJSON(test.input); got != test.want {
			t.Errorf("validJSON(%q)=%v", test.input, got)
		}
	}
}
