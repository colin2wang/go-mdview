// Package settings 定义应用设置类型、默认值与合法性归一化（不含持久化，持久化在 internal/storage）。
package settings

// ViewMode 正文显示模式。
const (
	ViewModeRender  = "render"  // 仅渲染结果
	ViewModeSource  = "source"  // 仅 Markdown 源码
	ViewModeSplit   = "split"   // 源码 ⇄ 渲染对照
	ViewModeMindmap = "mindmap" // 思维导图（渲染面板独占视图）
)

// Mermaid 图表渲染引擎。
const (
	MermaidEngineMermaid = "mermaid" // 经典 mermaid.js
	MermaidEnginePele    = "pele"    // 轻量同步渲染器
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

// 思维导图节点/备注单行最大字符数（超长自动折行），与前端 mindmap.ts 共用区间。
const (
	DefaultMmMaxLen = 20
	MinMmMaxLen     = 8
	MaxMmMaxLen     = 60
)

// 渲染区代码块最大显示行数（超出滚动），0 = 不限制。与前端 Viewer/style 共用。
const (
	DefaultCodeMaxLines = 20
	MinCodeMaxLines     = 0
	MaxCodeMaxLines     = 500
)

// Settings 应用设置。全部有默认值，读取时零值补齐。
type Settings struct {
	Theme         string `json:"theme"`         // light | dark
	FontSize      int    `json:"fontSize"`      // 正文基准字号 px，默认 16
	CodeWrap      bool   `json:"codeWrap"`      // 代码块自动换行
	LineNo        bool   `json:"lineNo"`        // 源码区显示行号，默认开
	SidebarWidth  int    `json:"sidebarWidth"`  // 侧栏宽度 px，默认 DefaultSidebarWidth
	LastFolder    string `json:"lastFolder"`    // 上次打开的目录
	LastFile      string `json:"lastFile"`      // 上次打开的文件
	Pinned        bool   `json:"pinned"`        // 窗口置顶
	ViewMode      string `json:"viewMode"`      // render | source | split | mindmap
	Language      string `json:"language"`      // 界面语言 zh-CN | en | ja | de
	AutoReload    bool   `json:"autoReload"`    // 外部修改自动重载，默认开
	BlockRemote   bool   `json:"blockRemote"`   // 拦截远程资源（http(s) 图片等），默认开，兑现「100% 离线」
	RemoteAllow   string `json:"remoteAllow"`   // 远程资源白名单：URL 通配符（* ?），多值每行一个，命中即放行
	UseYaml       bool   `json:"useYaml"`       // 用 exe 同目录 mdview.yml 作为配置源（存在时优先于 settings.json）
	MmMaxLen      int    `json:"mmMaxLen"`      // 思维导图节点/备注单行最大字符数，默认 DefaultMmMaxLen
	CodeMaxLines  int    `json:"codeMaxLines"`  // 代码块最大显示行数（含 mermaid/svg 源码块），0 = 不限制，默认 DefaultCodeMaxLines
	MermaidEngine string `json:"mermaidEngine"` // Mermaid 图表渲染引擎：mermaid | pele
	WinW          int    `json:"winW"`          // 上次关闭时窗口宽 px（0 = 未记录）
	WinH          int    `json:"winH"`          // 上次关闭时窗口高 px
	WinX          int    `json:"winX"`          // 上次关闭时窗口左上角 x（可为负，多显示器）
	WinY          int    `json:"winY"`          // 上次关闭时窗口左上角 y（可为负，多显示器）
	WinMax        bool   `json:"winMax"`        // 上次关闭时是否最大化
}

// DefaultSettings 默认值（读取时以此开局再反序列化，旧文件缺字段时保留默认值）。
var DefaultSettings = Settings{
	Theme:         "light",
	FontSize:      16,
	CodeWrap:      false,
	LineNo:        true,
	SidebarWidth:  DefaultSidebarWidth,
	ViewMode:      ViewModeRender,
	Language:      "zh-CN",
	AutoReload:    true,
	BlockRemote:   true,
	RemoteAllow:   "",
	UseYaml:       false,
	MmMaxLen:      DefaultMmMaxLen,
	CodeMaxLines:  DefaultCodeMaxLines,
	MermaidEngine: MermaidEnginePele,
}

// ValidViewMode 归一化显示模式，非法值回落到 render。
func ValidViewMode(v string) string {
	switch v {
	case ViewModeSource, ViewModeSplit, ViewModeMindmap:
		return v
	default:
		return ViewModeRender
	}
}

// ValidMermaidEngine 归一化图表渲染引擎，非法值回落到默认 Pele。
func ValidMermaidEngine(v string) string {
	if v == MermaidEngineMermaid {
		return MermaidEngineMermaid
	}
	return MermaidEnginePele
}

// ValidLanguage 归一化界面语言，非法值回落到 zh-CN。
func ValidLanguage(v string) string {
	switch v {
	case "en", "ja", "de", "zh-CN":
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

// Normalize 就地归一化 Settings 的全部字段到合法区间（读取与保存共用同一套规则）。
func Normalize(st *Settings) {
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = DefaultSettings.Theme
	}
	if st.FontSize < 12 || st.FontSize > 28 {
		st.FontSize = DefaultSettings.FontSize
	}
	if st.SidebarWidth < MinSidebarWidth || st.SidebarWidth > MaxSidebarWidth {
		st.SidebarWidth = DefaultSidebarWidth
	}
	if st.MmMaxLen < MinMmMaxLen || st.MmMaxLen > MaxMmMaxLen {
		st.MmMaxLen = DefaultMmMaxLen
	}
	if st.CodeMaxLines < MinCodeMaxLines || st.CodeMaxLines > MaxCodeMaxLines {
		st.CodeMaxLines = DefaultCodeMaxLines
	}
	st.ViewMode = ValidViewMode(st.ViewMode)
	st.Language = ValidLanguage(st.Language)
	st.MermaidEngine = ValidMermaidEngine(st.MermaidEngine)
	normalizeWindow(st)
}

// Clamp 保存前的收紧版归一化：与 Normalize 同规则，但越界值一律取边界而不是默认值。
func Clamp(st *Settings) {
	if st.Theme != "dark" && st.Theme != "light" {
		st.Theme = "light"
	}
	st.FontSize = clampInt(st.FontSize, 12, 28)
	st.SidebarWidth = clampInt(st.SidebarWidth, MinSidebarWidth, MaxSidebarWidth)
	st.MmMaxLen = clampInt(st.MmMaxLen, MinMmMaxLen, MaxMmMaxLen)
	st.CodeMaxLines = clampInt(st.CodeMaxLines, MinCodeMaxLines, MaxCodeMaxLines)
	st.ViewMode = ValidViewMode(st.ViewMode)
	st.Language = ValidLanguage(st.Language)
	st.MermaidEngine = ValidMermaidEngine(st.MermaidEngine)
	normalizeWindow(st)
}
