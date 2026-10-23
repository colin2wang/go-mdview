package mdv

// ViewMode 正文显示模式。
const (
	ViewModeRender = "render" // 仅渲染结果
	ViewModeSource = "source" // 仅 Markdown 源码
	ViewModeSplit  = "split"  // 源码 ⇄ 渲染对照
)

// 窗口尺寸：main.go 创建窗口与 settings 校验共用，避免两处硬编码不一致。
const (
	DefaultWindowWidth  = 1200
	DefaultWindowHeight = 800
	MinWindowWidth      = 720
	MinWindowHeight     = 420
)

// 侧栏宽度：与前端 SideBar.vue 的拖拽范围一致，设置页「重启」恢复到默认宽度。
const (
	DefaultSidebarWidth = 280
	MinSidebarWidth     = 200
	MaxSidebarWidth     = 520
)

// Settings 应用设置。全部有默认值，读取时零值补齐。
type Settings struct {
	Theme        string `json:"theme"`        // light | dark
	FontSize     int    `json:"fontSize"`     // 正文基准字号 px，默认 16
	CodeWrap     bool   `json:"codeWrap"`     // 代码块自动换行
	LineNo       bool   `json:"lineNo"`       // 源码区显示行号，默认开
	SidebarWidth int    `json:"sidebarWidth"` // 侧栏宽度 px，默认 DefaultSidebarWidth
	LastFolder   string `json:"lastFolder"`   // 上次打开的目录
	LastFile     string `json:"lastFile"`     // 上次打开的文件
	Pinned       bool   `json:"pinned"`       // 窗口置顶
	ViewMode     string `json:"viewMode"`     // render | source | split
	Language     string `json:"language"`     // 界面语言 zh-CN | en | ja | de
	WinW         int    `json:"winW"`         // 上次关闭时窗口宽 px（0 = 未记录）
	WinH         int    `json:"winH"`         // 上次关闭时窗口高 px
	WinX         int    `json:"winX"`         // 上次关闭时窗口左上角 x（可为负，多显示器）
	WinY         int    `json:"winY"`         // 上次关闭时窗口左上角 y
	WinMax       bool   `json:"winMax"`       // 上次关闭时是否最大化
}

var defaultSettings = Settings{
	Theme:        "light",
	FontSize:     16,
	CodeWrap:     false,
	LineNo:       true,
	SidebarWidth: DefaultSidebarWidth,
	ViewMode:     ViewModeRender,
	Language:     "zh-CN",
}

// validViewMode 归一化显示模式，非法值回落到 render。
func validViewMode(v string) string {
	switch v {
	case ViewModeSource, ViewModeSplit:
		return v
	default:
		return ViewModeRender
	}
}

// validLanguage 归一化界面语言，非法值回落到 zh-CN。
func validLanguage(v string) string {
	switch v {
	case "en", "ja", "de":
		return v
	case "zh-CN":
		return v
	default:
		return "zh-CN"
	}
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

// normalizeWindow 丢掉无效几何：尺寸小于最小窗口时视为未记录，位置保持原值
// （多显示器下 x/y 可以为负，不能按 0 判断是否记录过）。
func normalizeWindow(st *Settings) {
	if st.WinW < MinWindowWidth || st.WinH < MinWindowHeight {
		st.WinW, st.WinH = 0, 0
	}
}

// GetSettings 读取设置并补齐默认值/合法区间。
func (s *Store) GetSettings() Settings {
	// 以默认值开局再反序列化：旧版 settings.json 缺字段（如 lineNo）时保留默认值
	st := defaultSettings
	s.mu.Lock()
	s.readJSON("settings.json", &st)
	s.mu.Unlock()
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = defaultSettings.Theme
	}
	if st.FontSize < 12 || st.FontSize > 28 {
		st.FontSize = defaultSettings.FontSize
	}
	if st.SidebarWidth < MinSidebarWidth || st.SidebarWidth > MaxSidebarWidth {
		st.SidebarWidth = DefaultSidebarWidth
	}
	st.ViewMode = validViewMode(st.ViewMode)
	st.Language = validLanguage(st.Language)
	normalizeWindow(&st)
	return st
}

// SaveSettings 校验后落盘。
func (s *Store) SaveSettings(in Settings) Settings {
	st := in
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = "light"
	}
	st.FontSize = clampInt(st.FontSize, 12, 28)
	st.SidebarWidth = clampInt(st.SidebarWidth, MinSidebarWidth, MaxSidebarWidth)
	st.ViewMode = validViewMode(st.ViewMode)
	st.Language = validLanguage(st.Language)
	normalizeWindow(&st)
	s.mu.Lock()
	s.writeJSON("settings.json", &st)
	s.mu.Unlock()
	return st
}
