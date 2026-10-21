package mdv

// Settings 应用设置。全部有默认值，读取时零值补齐。
type Settings struct {
	Theme        string `json:"theme"`        // light | dark
	FontSize     int    `json:"fontSize"`     // 正文基准字号 px，默认 16
	CodeWrap     bool   `json:"codeWrap"`     // 代码块自动换行
	SidebarWidth int    `json:"sidebarWidth"` // 侧栏宽度 px，默认 280
	LastFolder   string `json:"lastFolder"`   // 上次打开的目录
	LastFile     string `json:"lastFile"`     // 上次打开的文件
	Pinned       bool   `json:"pinned"`       // 窗口置顶
}

var defaultSettings = Settings{
	Theme:        "light",
	FontSize:     16,
	CodeWrap:     false,
	SidebarWidth: 280,
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// GetSettings 读取设置并补齐默认值/合法区间。
func (s *Store) GetSettings() Settings {
	var st Settings
	s.mu.Lock()
	s.readJSON("settings.json", &st)
	s.mu.Unlock()
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = defaultSettings.Theme
	}
	if st.FontSize < 12 || st.FontSize > 28 {
		st.FontSize = defaultSettings.FontSize
	}
	if st.SidebarWidth < 200 || st.SidebarWidth > 520 {
		st.SidebarWidth = defaultSettings.SidebarWidth
	}
	return st
}

// SaveSettings 校验后落盘。
func (s *Store) SaveSettings(in Settings) Settings {
	st := in
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = "light"
	}
	st.FontSize = clampInt(st.FontSize, 12, 28)
	st.SidebarWidth = clampInt(st.SidebarWidth, 200, 520)
	s.mu.Lock()
	s.writeJSON("settings.json", &st)
	s.mu.Unlock()
	return st
}
