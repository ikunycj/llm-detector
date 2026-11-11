package newapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"llm-detector/pkg/project"
)

type Adapter struct{ Timeout time.Duration }

var (
	errNewAPIRateLimited         = errors.New("New API 接口请求过于频繁，请等待限流窗口结束后重试")
	errNewAPIVerificationNeeded  = errors.New("New API 尚未完成安全验证；请填写 Access Token 所属管理员当前的 2FA 验证码。其他浏览器中的验证状态不会自动传给本服务")
	errNewAPIVerificationInvalid = errors.New("New API 安全验证状态无效；请使用新的 2FA 验证码重新导入")
	errNewAPIVerificationExpired = errors.New("New API 安全验证已过期；请使用新的 2FA 验证码重新导入")
)

const newAPIKeyImportRateLimited = "New API 渠道密钥接口请求过于频繁，已停止继续读取；请等待限流窗口结束后重试"

func (Adapter) ID() string { return "newapi" }

func (a Adapter) client() *http.Client {
	return &http.Client{Timeout: a.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// Only fixed diagnostics leave this boundary; upstream bodies can echo secrets.
func request(ctx context.Context, client *http.Client, conn project.Connection, method, route string, body, result any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, conn.BaseURL+route, reader)
	if err != nil {
		return errors.New("无法构造 New API 请求")
	}
	if conn.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+conn.AccessToken)
	}
	if conn.UserID > 0 {
		req.Header.Set("New-Api-User", strconv.Itoa(conn.UserID))
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("New API 连接失败或超时，请检查地址、网络和 TLS")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusTooManyRequests {
		return errNewAPIRateLimited
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, (8<<20)+1))
	if err != nil || len(data) > 8<<20 {
		return errors.New("New API 响应读取失败或超出 8 MiB")
	}
	var envelope struct {
		Success bool            `json:"success"`
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return fmt.Errorf("New API 返回非预期 JSON（HTTP %d）", resp.StatusCode)
	}
	switch envelope.Code {
	case "VERIFICATION_REQUIRED":
		return errNewAPIVerificationNeeded
	case "VERIFICATION_INVALID":
		return errNewAPIVerificationInvalid
	case "VERIFICATION_EXPIRED":
		return errNewAPIVerificationExpired
	}
	if !envelope.Success || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Match only known fixed responses, never forward arbitrary messages.
		switch envelope.Message {
		case "无权进行此操作，权限不足", "Unauthorized, insufficient privileges":
			if strings.HasPrefix(route, "/api/channel/") && strings.HasSuffix(route, "/key") {
				return errors.New("New API 拒绝读取渠道密钥：需要 Root 管理员权限，能同步渠道列表不代表有权读取 Key")
			}
			return errors.New("New API 权限不足，请检查管理令牌所属账号的权限")
		case "无权进行此操作，access token 无效", "Unauthorized, invalid access token":
			return errors.New("New API 管理员 Access Token 无效，请在项目连接中更新管理访问令牌")
		case "无权进行此操作，New-Api-User 与登录用户不匹配", "Unauthorized, New-Api-User does not match logged in user":
			return errors.New("New API User ID 与 Access Token 所属管理员不匹配，请检查项目连接")
		case "用户未启用2FA或Passkey":
			return errors.New("New API 管理员未启用 2FA 或 Passkey，无法完成安全验证；当前导入流程支持 2FA 验证码")
		case "用户未启用2FA":
			return errors.New("New API 管理员未启用 2FA；仅启用 Passkey 的账号不能使用当前验证码导入流程")
		case "验证码不能为空", "验证失败，请检查验证码":
			return errors.New("New API 拒绝该 2FA 验证码，请确认账号并使用新的有效验证码重试")
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("New API 返回 HTTP %d；请检查管理员权限与 User ID", resp.StatusCode)
	}
	if !envelope.Success {
		return errors.New("New API 拒绝请求；请检查访问令牌、User ID、权限或 2FA 验证码")
	}
	if result != nil && (len(envelope.Data) == 0 || string(envelope.Data) == "null" || json.Unmarshal(envelope.Data, result) != nil) {
		return errors.New("New API 响应数据结构不兼容")
	}
	return nil
}

type rawChannel struct {
	ID             int    `json:"id"`
	Type           int    `json:"type"`
	Name           string `json:"name"`
	BaseURL        string `json:"base_url"`
	Group          string `json:"group"`
	Tag            string `json:"tag"`
	Models         string `json:"models"`
	Status         int    `json:"status"`
	ModelMapping   string `json:"model_mapping"`
	HeaderOverride string `json:"header_override"`
	ParamOverride  string `json:"param_override"`
	Organization   string `json:"openai_organization"`
	ChannelInfo    struct {
		IsMultiKey bool        `json:"is_multi_key"`
		Status     map[int]int `json:"multi_key_status_list"`
	} `json:"channel_info"`
}

func (a Adapter) Discover(ctx context.Context, conn project.Connection) ([]project.Channel, error) {
	client := a.client()
	channels := []project.Channel{}
	seen := map[int]bool{}
	for page := 1; ; page++ {
		var response struct {
			Items *[]rawChannel `json:"items"`
			Total *int          `json:"total"`
		}
		if err := request(ctx, client, conn, "GET", fmt.Sprintf("/api/channel/?p=%d&page_size=100&id_sort=true", page), nil, &response); err != nil {
			return nil, err
		}
		if response.Items == nil || response.Total == nil || *response.Total < 0 {
			return nil, errors.New("New API 渠道分页缺少 items/total")
		}
		if len(*response.Items) == 0 && len(channels) < *response.Total {
			return nil, errors.New("New API 渠道分页提前结束，请重新同步")
		}
		for _, raw := range *response.Items {
			if raw.ID <= 0 || seen[raw.ID] {
				return nil, errors.New("New API 渠道分页出现重复或无效 ID，请重新同步")
			}
			seen[raw.ID] = true
			channels = append(channels, convert(raw))
		}
		if len(channels) >= *response.Total {
			break
		}
	}
	return channels, nil
}

func convert(raw rawChannel) project.Channel {
	item := project.Channel{ID: strconv.Itoa(raw.ID), Name: raw.Name, Groups: split(raw.Group), Tag: strings.TrimSpace(raw.Tag), Models: split(raw.Models), Organization: strings.TrimSpace(raw.Organization), Enabled: raw.Status == 1, MultiKey: raw.ChannelInfo.IsMultiKey, KeyStatus: raw.ChannelInfo.Status}
	base := strings.TrimRight(strings.TrimSpace(raw.BaseURL), "/")
	switch raw.Type {
	case 1:
		item.Protocol = "chat_completions"
		if base == "" {
			base = "https://api.openai.com"
		}
	case 14:
		item.Protocol = "messages"
		if base == "" {
			base = "https://api.anthropic.com"
		}
	default:
		item.Issue = fmt.Sprintf("暂不支持直连渠道类型 %d；当前支持 OpenAI(1) / Anthropic(14)", raw.Type)
	}
	item.BaseURL = base
	u, err := url.Parse(base)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		item.Issue = "渠道 Base URL 无效或包含认证/查询参数"
		item.BaseURL = ""
		return item
	}
	if item.Issue != "" {
		return item
	}
	if !strings.HasSuffix(u.Path, "/v1") {
		u.Path = strings.TrimRight(u.Path, "/") + "/v1"
	}
	item.BaseURL = u.String()
	for _, override := range []string{raw.HeaderOverride, raw.ParamOverride} {
		if strings.TrimSpace(override) != "" && strings.TrimSpace(override) != "{}" && strings.TrimSpace(override) != "null" {
			item.Issue = "渠道有自定义请求头或参数覆盖，当前直连检测不复现这些设置"
			return item
		}
	}
	mapping := map[string]string{}
	if raw.ModelMapping != "" && json.Unmarshal([]byte(raw.ModelMapping), &mapping) != nil {
		item.Issue = "渠道模型映射格式无效"
		return item
	}
	models := []string{}
	for _, model := range item.Models {
		if replacement, ok := mapping[model]; ok {
			model = strings.TrimSpace(replacement)
		}
		if model != "" && !slices.Contains(models, model) {
			models = append(models, model)
		}
	}
	item.Models = models
	if len(models) == 0 {
		item.Issue = "渠道没有可巡检的模型"
	}
	return item
}

func split(value string) []string {
	items := []string{}
	for _, v := range strings.Split(value, ",") {
		v = strings.TrimSpace(v)
		if v != "" && !slices.Contains(items, v) {
			items = append(items, v)
		}
	}
	return items
}

func (a Adapter) ImportKeys(ctx context.Context, conn project.Connection, channels []project.Channel, code string) (map[string]string, map[string]string, error) {
	client := a.client()
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, nil, err
	}
	client.Jar = jar
	if code != "" {
		var verification struct {
			Verified bool `json:"verified"`
		}
		if err := request(ctx, client, conn, "POST", "/api/verify", map[string]string{"method": "2fa", "code": code}, &verification); err != nil {
			return nil, nil, err
		}
		if !verification.Verified {
			return nil, nil, errors.New("New API 未确认安全验证成功，未继续读取渠道密钥")
		}
	}
	keys := map[string]string{}
	failures := map[string]string{}
	for index, channel := range channels {
		if err := ctx.Err(); err != nil {
			return keys, failures, err
		}
		var result struct {
			Key string `json:"key"`
		}
		if err := request(ctx, client, conn, "POST", "/api/channel/"+url.PathEscape(channel.ID)+"/key", map[string]any{}, &result); err != nil {
			if errors.Is(err, errNewAPIRateLimited) {
				failures[channel.ID] = newAPIKeyImportRateLimited
				for _, remaining := range channels[index+1:] {
					failures[remaining.ID] = newAPIKeyImportRateLimited
				}
				break
			}
			if errors.Is(err, errNewAPIVerificationNeeded) || errors.Is(err, errNewAPIVerificationInvalid) || errors.Is(err, errNewAPIVerificationExpired) {
				failures[channel.ID] = err.Error()
				for _, remaining := range channels[index+1:] {
					failures[remaining.ID] = err.Error()
				}
				break
			}
			failures[channel.ID] = err.Error()
			continue
		}
		values := strings.Split(strings.TrimSpace(result.Key), "\n")
		if !channel.MultiKey && len(values) != 1 {
			failures[channel.ID] = "单密钥渠道返回了多个值"
			continue
		}
		for i, value := range values {
			if status, ok := channel.KeyStatus[i]; ok && status != 1 {
				continue
			}
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			if strings.HasPrefix(value, "{") || strings.HasPrefix(value, "[") || strings.ContainsAny(value, "\r\n") || strings.Contains(value, "*") {
				continue
			}
			keys[channel.ID] = value
			break
		}
		if keys[channel.ID] == "" {
			failures[channel.ID] = "没有可用的普通 API Key（不支持 OAuth/JSON 凭据或掩码值）"
		}
	}
	return keys, failures, nil
}

func (a Adapter) ResolveUserID(ctx context.Context, conn project.Connection, account, password, code string) (int, error) {
	client := a.client()
	jar, err := cookiejar.New(nil)
	if err != nil {
		return 0, err
	}
	client.Jar = jar
	session := project.Connection{BaseURL: conn.BaseURL}
	var response struct {
		ID          int  `json:"id"`
		Role        int  `json:"role"`
		Requires2FA bool `json:"require_2fa"`
	}
	if err := request(ctx, client, session, "POST", "/api/user/login", map[string]string{"username": account, "password": password}, &response); err != nil {
		return 0, err
	}
	if response.Requires2FA {
		if code == "" {
			return 0, errors.New("目标账号要求登录 2FA；请填写当前验证码。若目标启用 Turnstile/Passkey，请使用高级 User ID 方式")
		}
		if err := request(ctx, client, session, "POST", "/api/user/login/2fa", map[string]string{"code": code}, &response); err != nil {
			return 0, err
		}
	}
	if response.ID <= 0 || response.Role < 10 {
		return 0, errors.New("目标账号不是管理员，或登录响应不包含有效用户 ID")
	}
	// A fresh client ensures the supplied long-lived token belongs to this ID,
	// rather than being accepted through the password-login cookie.
	conn.UserID = response.ID
	var self struct {
		ID   int `json:"id"`
		Role int `json:"role"`
	}
	if err := request(ctx, a.client(), conn, "GET", "/api/user/self", nil, &self); err != nil {
		return 0, err
	}
	if self.ID != response.ID || self.Role < 10 {
		return 0, errors.New("Access Token 与登录账号不匹配或缺少管理员权限")
	}
	return response.ID, nil
}
