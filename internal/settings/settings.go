// Package settings defines the app settings type, defaults, and validation.
// It contains no persistence; that lives in internal/storage.
package settings

// View modes.
const (
	ViewModeRender  = "render"  // rendered output only
	ViewModeSource  = "source"  // markdown source only
	ViewModeSplit   = "split"   // source next to render
	ViewModeMindmap = "mindmap" // mind map
)

// Mermaid diagram engines.
const (
	MermaidEngineMermaid = "mermaid" // classic mermaid.js
	MermaidEnginePele    = "pele"    // lightweight synchronous renderer
)

// Window size constants shared by window creation and validation.
const (
	DefaultWindowWidth  = 1200
	DefaultWindowHeight = 800
	MinWindowWidth      = 720
	MinWindowHeight     = 420
)

// Sidebar width bounds, matching the sidebar drag range in the frontend.
const (
	DefaultSidebarWidth = 280
	MinSidebarWidth     = 200
	MaxSidebarWidth     = 520
)

// Mind map wrap length (max characters per node/note line), shared with the frontend.
const (
	DefaultMmMaxLen = 20
	MinMmMaxLen     = 8
	MaxMmMaxLen     = 60
)

// Rendered code block max visible lines (0 = unlimited), shared with the frontend.
const (
	DefaultCodeMaxLines = 20
	MinCodeMaxLines     = 0
	MaxCodeMaxLines     = 500
)

// Settings holds the application settings; every field has a default.
type Settings struct {
	Theme           string `json:"theme"`           // light | dark
	FontSize        int    `json:"fontSize"`        // base body font size in px, default 16
	CodeWrap        bool   `json:"codeWrap"`        // wrap long lines in code blocks
	LineNo          bool   `json:"lineNo"`          // show line numbers in the source pane
	CodeBlockLineNo bool   `json:"codeBlockLineNo"` // show line numbers in rendered code blocks and diagram source
	SidebarWidth    int    `json:"sidebarWidth"`    // sidebar width in px
	LastFolder      string `json:"lastFolder"`      // last opened folder
	LastFile        string `json:"lastFile"`        // last opened file
	Pinned          bool   `json:"pinned"`          // always-on-top window
	ViewMode        string `json:"viewMode"`        // render | source | split | mindmap
	Language        string `json:"language"`        // UI language: zh-CN | en | ja | de
	AutoReload      bool   `json:"autoReload"`      // reload automatically on external change
	BlockRemote     bool   `json:"blockRemote"`     // block remote http(s) resources
	RemoteAllow     string `json:"remoteAllow"`     // remote whitelist: URL wildcards, one per line
	UseYaml         bool   `json:"useYaml"`         // use exe-adjacent mdview.yml as config source
	MmMaxLen        int    `json:"mmMaxLen"`        // mind map wrap length
	CodeMaxLines    int    `json:"codeMaxLines"`    // code block max visible lines, 0 = unlimited
	MermaidEngine   string `json:"mermaidEngine"`   // mermaid | pele
	WinW            int    `json:"winW"`            // window width on last close (0 = not recorded)
	WinH            int    `json:"winH"`            // window height on last close
	WinX            int    `json:"winX"`            // window x on last close (may be negative)
	WinY            int    `json:"winY"`            // window y on last close
	WinMax          bool   `json:"winMax"`          // window was maximized on close
}

// DefaultSettings holds the default values; reads start from it so missing
// fields in old files keep their defaults.
var DefaultSettings = Settings{
	Theme:           "light",
	FontSize:        16,
	CodeWrap:        false,
	LineNo:          true,
	CodeBlockLineNo: true,
	SidebarWidth:    DefaultSidebarWidth,
	ViewMode:        ViewModeRender,
	Language:        "zh-CN",
	AutoReload:      true,
	BlockRemote:     true,
	RemoteAllow:     "",
	UseYaml:         false,
	MmMaxLen:        DefaultMmMaxLen,
	CodeMaxLines:    DefaultCodeMaxLines,
	MermaidEngine:   MermaidEnginePele,
}

// ValidViewMode normalizes a view mode, falling back to render.
func ValidViewMode(v string) string {
	switch v {
	case ViewModeSource, ViewModeSplit, ViewModeMindmap:
		return v
	default:
		return ViewModeRender
	}
}

// ValidMermaidEngine normalizes the diagram engine, falling back to Pele.
func ValidMermaidEngine(v string) string {
	if v == MermaidEngineMermaid {
		return MermaidEngineMermaid
	}
	return MermaidEnginePele
}

// ValidLanguage normalizes the UI language, falling back to zh-CN.
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

// normalizeWindow drops invalid geometry: sizes below the minimum mean "not
// recorded"; positions are kept because multi-monitor x/y can be negative.
func normalizeWindow(st *Settings) {
	if st.WinW < MinWindowWidth || st.WinH < MinWindowHeight {
		st.WinW, st.WinH = 0, 0
	}
}

// Normalize forces every field into a valid value, replacing invalid ones
// with defaults.
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

// Clamp clamps out-of-range values to the boundary instead of the default.
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
