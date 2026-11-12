package inspection

import (
	"strings"
)

// Transfer is returned only by an explicit authenticated transfer operation.
// Public project and run views never contain credentials.
type Transfer struct {
	View        Project           `json:"view"`
	AccessToken string            `json:"access_token"`
	Keys        map[string]string `json:"keys"`
}

func (s *Service) Export(id string) (Transfer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return Transfer{}, s.fault
	}
	raw, ok := cloneState(s.state).Projects[id]
	if !ok {
		return Transfer{}, ErrNotFound
	}
	return Transfer{View: raw.View, AccessToken: raw.AccessToken, Keys: raw.Keys}, nil
}

// Import copies a project without its run history. Schedules start disabled.
func (s *Service) Import(input Transfer) (Project, error) {
	view := input.View
	if strings.TrimSpace(view.Name) == "" || len([]rune(view.Name)) > 100 {
		return Project{}, invalid("项目名称无效")
	}
	if _, ok := s.adapters[view.Kind]; !ok {
		return Project{}, invalid("项目类型未注册")
	}
	base, err := validateURL(view.BaseURL)
	if err != nil {
		return Project{}, err
	}
	if view.UserID <= 0 || strings.TrimSpace(input.AccessToken) == "" || strings.ContainsAny(input.AccessToken, "\r\n") {
		return Project{}, invalid("项目管理员与密钥无效")
	}
	seen := map[string]bool{}
	keys := map[string]string{}
	for i := range view.Channels {
		ch := &view.Channels[i]
		if ch.ID == "" || seen[ch.ID] {
			return Project{}, invalid("渠道标识无效")
		}
		seen[ch.ID] = true
		// Unsupported channel metadata may have no URL; it cannot execute until synchronized.
		if ch.BaseURL != "" {
			if _, err := validateURL(ch.BaseURL); err != nil {
				return Project{}, err
			}
		}
		if ch.ProtocolOverride != "" && ch.ProtocolOverride != "chat_completions" && ch.ProtocolOverride != "responses" && ch.ProtocolOverride != "messages" {
			return Project{}, invalid("测试协议无效")
		}
		if key := input.Keys[ch.ID]; key != "" {
			if strings.ContainsAny(key, "\r\n") {
				return Project{}, invalid("渠道密钥无效")
			}
			keys[ch.ID] = key
		}
		ch.HasKey = keys[ch.ID] != ""
	}
	if view.Channels == nil {
		view.Channels = []ChannelView{}
	}
	if view.Groups == nil {
		view.Groups = []string{}
	}
	view.ID, err = newID("project")
	if err != nil {
		return Project{}, err
	}
	view.BaseURL = base
	view.HasToken = true
	view.Busy = false
	view.Plan.Enabled = false
	view.NextRunAt = nil
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fault != nil {
		return Project{}, s.fault
	}
	next := cloneState(s.state)
	next.Projects[view.ID] = diskProject{View: view, AccessToken: input.AccessToken, Keys: keys}
	if err := s.commit(next); err != nil {
		return Project{}, err
	}
	return view, nil
}
