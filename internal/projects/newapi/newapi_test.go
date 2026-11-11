package newapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"llm-detector/pkg/project"
)

func TestDiscoveryPaginationAndOfficialKeyVerification(t *testing.T) {
	var pages atomic.Int32
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer management-fixture" || r.Header.Get("New-Api-User") != "7" {
			t.Error("missing New API management authentication")
		}
		w.Header().Set("Content-Type", "application/json")
		var data any
		switch r.URL.Path {
		case "/api/channel/":
			pages.Add(1)
			if r.URL.Query().Get("p") == "1" {
				if r.URL.Query().Get("page_size") != "100" {
					t.Error("missing page size")
				}
				data = map[string]any{"total": 3, "items": []any{
					map[string]any{"id": 1, "name": "OpenAI channel", "type": 1, "status": 1, "base_url": upstream.URL, "group": "default,vip", "models": "alias,second", "model_mapping": `{"alias":"upstream-a"}`, "channel_info": map[string]any{"is_multi_key": true, "multi_key_status_list": map[string]int{"0": 2, "1": 1}}},
					map[string]any{"id": 2, "name": "Messages channel", "type": 14, "status": 1, "base_url": upstream.URL + "/v1", "group": "vip", "models": "claude-test"},
				}}
			} else {
				data = map[string]any{"total": 3, "items": []any{map[string]any{"id": 3, "type": 8, "name": "Azure", "status": 1, "models": "gpt", "group": "default"}}}
			}
		case "/api/verify":
			var input map[string]string
			if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
				t.Error(err)
			}
			if input["method"] != "2fa" || input["code"] != "123456" {
				t.Error("invalid verification flow")
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "verified-fixture", Path: "/"})
			data = map[string]bool{"verified": true}
		case "/api/channel/1/key":
			cookie, err := r.Cookie("session")
			if err != nil || cookie.Value != "verified-fixture" {
				t.Error("verification cookie not forwarded")
			}
			data = map[string]string{"key": "disabled-key\nactive-key"}
		case "/api/channel/2/key":
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(map[string]any{"success": false, "code": "VERIFICATION_EXPIRED", "message": "secret-echo"})
			return
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data})
	}))
	defer upstream.Close()
	adapter := Adapter{Timeout: time.Second}
	conn := project.Connection{BaseURL: upstream.URL, AccessToken: "management-fixture", UserID: 7}
	channels, err := adapter.Discover(context.Background(), conn)
	if err != nil {
		t.Fatal(err)
	}
	if pages.Load() != 2 || len(channels) != 3 {
		t.Fatalf("pagination: pages=%d channels=%d", pages.Load(), len(channels))
	}
	if channels[0].BaseURL != upstream.URL+"/v1" || channels[1].BaseURL != upstream.URL+"/v1" || channels[1].Protocol != "messages" {
		t.Fatal("protocol or URL mapping incorrect")
	}
	if strings.Join(channels[0].Models, ",") != "upstream-a,second" || len(channels[0].Groups) != 2 || channels[2].Issue == "" {
		t.Fatal("channel mapping or unsupported type omitted")
	}
	keys, failures, err := adapter.ImportKeys(context.Background(), conn, channels[:2], "123456")
	if err != nil {
		t.Fatal(err)
	}
	if keys["1"] != "active-key" || keys["2"] != "" || !strings.Contains(failures["2"], "安全验证") {
		t.Fatal("per-channel import result incorrect")
	}
	if strings.Contains(failures["2"], "secret-echo") {
		t.Fatal("raw upstream error was exposed")
	}
}

func TestDoesNotFollowCredentialRedirect(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer source.Close()
	_, err := (Adapter{Timeout: time.Second}).Discover(context.Background(), project.Connection{BaseURL: source.URL, AccessToken: "fixture", UserID: 1})
	if err == nil || hits.Load() != 0 {
		t.Fatal("followed credential-bearing redirect")
	}
}

func TestRejectIncompletePagination(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"items": []any{}, "total": 1}})
	}))
	defer srv.Close()
	if _, err := (Adapter{Timeout: time.Second}).Discover(context.Background(), project.Connection{BaseURL: srv.URL, AccessToken: "fixture", UserID: 1}); err == nil {
		t.Fatal("partial list returned as success")
	}
}

func TestImportKeyDiagnosticsDoNotExposeUpstreamBodies(t *testing.T) {
	for _, test := range []struct {
		name, message, code, want string
		status                    int
		verify                    bool
	}{
		{name: "root-permission", status: 200, message: "无权进行此操作，权限不足", want: "Root 管理员"},
		{name: "root-permission-english", status: 403, message: "Unauthorized, insufficient privileges", want: "Root 管理员"},
		{name: "invalid-token", status: 200, message: "无权进行此操作，access token 无效", want: "Access Token 无效"},
		{name: "user-id-mismatch", status: 401, message: "Unauthorized, New-Api-User does not match logged in user", want: "不匹配"},
		{name: "verification-required", status: 403, code: "VERIFICATION_REQUIRED", want: "尚未完成安全验证"},
		{name: "verification-expired", status: 403, code: "VERIFICATION_EXPIRED", want: "安全验证已过期"},
		{name: "verification-invalid", status: 403, code: "VERIFICATION_INVALID", want: "安全验证状态无效"},
		{name: "no-verification-method", status: 200, message: "用户未启用2FA或Passkey", want: "未启用 2FA 或 Passkey", verify: true},
		{name: "no-totp", status: 200, message: "用户未启用2FA", want: "未启用 2FA", verify: true},
		{name: "invalid-totp", status: 200, message: "验证失败，请检查验证码", want: "拒绝该 2FA 验证码", verify: true},
		{name: "rate-limit", status: 429, want: "请求过于频繁"},
		{name: "unknown-with-secret", status: 200, message: "secret-fixture-value", want: "New API 拒绝请求"},
		{name: "known-prefix-with-secret", status: 200, message: "无权进行此操作，权限不足 secret-fixture-value", want: "New API 拒绝请求"},
	} {
		t.Run(test.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if test.verify && r.URL.Path != "/api/verify" {
					t.Error("read channel key after verification failed")
				}
				w.WriteHeader(test.status)
				json.NewEncoder(w).Encode(map[string]any{"success": false, "code": test.code, "message": test.message, "data": map[string]string{"key": "secret-fixture-value"}})
			}))
			defer srv.Close()
			code := ""
			if test.verify {
				code = "123456"
			}
			keys, failures, err := (Adapter{Timeout: time.Second}).ImportKeys(context.Background(), project.Connection{BaseURL: srv.URL, AccessToken: "management-fixture", UserID: 7}, []project.Channel{{ID: "1"}}, code)
			message := failures["1"]
			if test.verify {
				if err == nil {
					t.Fatal("verification error was not returned")
				}
				message = err.Error()
			} else if err != nil {
				t.Fatal(err)
			}
			if len(keys) != 0 || !strings.Contains(message, test.want) || strings.Contains(message, "secret-fixture-value") {
				t.Fatalf("incorrect or unsafe diagnostic: %s", message)
			}
		})
	}
}

func TestRateLimitedKeyImportStopsWithoutParsingUpstreamBody(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch r.URL.Path {
		case "/api/channel/1/key":
			json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]string{"key": "fixture-key"}})
		case "/api/channel/2/key":
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte("upstream rate limit page with no JSON"))
		case "/api/channel/3/key":
			t.Error("key import continued after rate limit")
		default:
			t.Errorf("unexpected route %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	keys, failures, err := (Adapter{Timeout: time.Second}).ImportKeys(context.Background(), project.Connection{BaseURL: srv.URL, AccessToken: "fixture", UserID: 1}, []project.Channel{{ID: "1"}, {ID: "2"}, {ID: "3"}}, "")
	if err != nil {
		t.Fatal(err)
	}
	if keys["1"] != "fixture-key" || !strings.Contains(failures["2"], "限流") || !strings.Contains(failures["3"], "停止继续") || requests.Load() != 2 {
		t.Fatalf("unexpected rate-limit handling: keys=%v failures=%v requests=%d", keys, failures, requests.Load())
	}
	if strings.Contains(failures["2"], "upstream rate limit page") || strings.Contains(failures["3"], "upstream rate limit page") {
		t.Fatal("raw rate-limit response was exposed")
	}
}

func TestImportDoesNotReadKeysWithoutConfirmedVerification(t *testing.T) {
	var keyRequests atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/verify" {
			keyRequests.Add(1)
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]bool{"verified": false}})
	}))
	defer srv.Close()
	_, _, err := (Adapter{Timeout: time.Second}).ImportKeys(context.Background(), project.Connection{BaseURL: srv.URL, AccessToken: "management-fixture", UserID: 7}, []project.Channel{{ID: "1"}}, "123456")
	if err == nil || !strings.Contains(err.Error(), "未确认安全验证成功") || keyRequests.Load() != 0 {
		t.Fatal("key request proceeded without successful verification")
	}
}

func TestResolveAccountEmailUsesLogin2FAAndVerifiesTokenOwner(t *testing.T) {
	var tokenChecks atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var data any
		switch r.URL.Path {
		case "/api/user/login":
			if r.Header.Get("Authorization") != "" {
				t.Error("management token sent to login")
			}
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["username"] != "admin@example.com" || body["password"] != "fixture-login-password" {
				t.Error("account/password not forwarded to login")
			}
			http.SetCookie(w, &http.Cookie{Name: "session", Value: "pending", Path: "/"})
			data = map[string]any{"require_2fa": true}
		case "/api/user/login/2fa":
			if _, err := r.Cookie("session"); err != nil {
				t.Error("pending session lost")
			}
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			if body["code"] != "123456" {
				t.Error("2FA not forwarded")
			}
			data = map[string]any{"id": 9, "role": 100}
		case "/api/user/self":
			tokenChecks.Add(1)
			if _, err := r.Cookie("session"); err == nil {
				t.Error("token identity check reused authenticated cookie")
			}
			if r.Header.Get("Authorization") != "Bearer fixture-token" || r.Header.Get("New-Api-User") != "9" {
				t.Error("resolved identity not used")
			}
			data = map[string]any{"id": 9, "role": 100}
		default:
			t.Error("unexpected route")
		}
		json.NewEncoder(w).Encode(map[string]any{"success": true, "data": data})
	}))
	defer srv.Close()
	id, err := (Adapter{Timeout: time.Second}).ResolveUserID(context.Background(), project.Connection{BaseURL: srv.URL, AccessToken: "fixture-token"}, "admin@example.com", "fixture-login-password", "123456")
	if err != nil || id != 9 || tokenChecks.Load() != 1 {
		t.Fatalf("identity resolution failed: id=%d err=%v", id, err)
	}
}

func TestOrganizationMetadataDoesNotDisableChannel(t *testing.T) {
	item := convert(rawChannel{ID: 197, Type: 1, Name: "organization-fixture", Tag: "tag-fixture", Status: 1, BaseURL: "https://upstream.invalid", Organization: "org-fixture", Models: "alias", ModelMapping: `{"alias":"model-upstream"}`})
	if item.Issue != "" || item.Organization != "org-fixture" || item.Tag != "tag-fixture" || item.Protocol != "chat_completions" || len(item.Models) != 1 || item.Models[0] != "model-upstream" {
		t.Fatalf("organization disabled channel or skipped model mapping: %+v", item)
	}
}
