package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"mdview/internal/mdv"
)

// RelaunchFlag 「重启」拉起新进程时附加的标记：main 见到它先等旧进程退出，
// 否则新进程会撞上单实例锁，被当成二次启动转交后直接退出。
const RelaunchFlag = "--mdview-relaunch"

// IsRelaunch 判断本进程是否由设置页「重启」拉起。
func IsRelaunch(args []string) bool {
	for _, arg := range args {
		if arg == RelaunchFlag {
			return true
		}
	}
	return false
}

// App Wails 绑定层：前端可调用的全部方法挂在这里。
type App struct {
	ctx        context.Context
	store      *mdv.Store
	restarting atomic.Bool // 重启中：关闭前不能再把当前几何写回设置
}

func NewApp() *App { return &App{store: mdv.NewStore()} }

// Startup Wails 生命周期回调。
func (a *App) Startup(ctx context.Context) {
	a.ctx = ctx
	// 还原上次关闭时的窗口几何：尺寸已由 wails.Run 的 Width/Height 初始化，
	// 这里补位置；最大化放在最后，退出最大化时能回到记录的普通尺寸
	if st := a.store.GetSettings(); st.WinW > 0 && st.WinH > 0 {
		a.restoreWindowPosition(ctx, st.WinX, st.WinY)
		if st.WinMax {
			wruntime.WindowMaximise(ctx)
		}
	}
	// 拖拽 .md 打开由前端 JS runtime.OnFileDrop 处理（store.ts initApp）：
	// Windows 上 Go 端 OnFileDrop 必须依赖 JS 端监听才会触发（Wails v2 #3985），
	// 为避免同一次 drop 双路触发，这里不再重复注册。
}

// restoreWindowPosition 把窗口放到屏幕绝对坐标 (x, y)。
// Wails 在 Windows 上的 WindowSetPosition 以「窗口当前显示器工作区左上角」为原点，
// 而 WindowGetPosition 返回屏幕绝对坐标：先把窗口挪到相对 (0,0) 量出工作区原点，
// 再用相对坐标一次定位。任务栏在左侧/顶部时工作区原点不为 0，不换算会每次启动漂移；
// 先落到原点也保证换算基准与目标在同一块屏幕上，多显示器同时用不同 DPI 时同样成立。
func (a *App) restoreWindowPosition(ctx context.Context, x, y int) {
	wruntime.WindowSetPosition(ctx, 0, 0)
	ox, oy := wruntime.WindowGetPosition(ctx)
	wruntime.WindowSetPosition(ctx, x-ox, y-oy)
}

// BeforeClose 窗口关闭前记录几何，供下次启动还原（返回 false 不阻断关闭）。
func (a *App) BeforeClose(ctx context.Context) bool {
	a.saveWindowState(ctx)
	return false
}

// saveWindowState 只记录可还原的普通窗口几何：
// 最大化时保留上次普通尺寸只置标记，最小化/全屏时坐标不可靠则原样保留。
func (a *App) saveWindowState(ctx context.Context) {
	if a.restarting.Load() { // 重启已主动清空几何，不能再写回去
		return
	}
	st := a.store.GetSettings()
	switch {
	case wruntime.WindowIsFullscreen(ctx), wruntime.WindowIsMinimised(ctx):
		return
	case wruntime.WindowIsMaximised(ctx):
		st.WinMax = true
		a.store.SaveSettings(st)
		return
	}
	x, y := wruntime.WindowGetPosition(ctx)
	w, h := wruntime.WindowGetSize(ctx)
	if w < mdv.MinWindowWidth || h < mdv.MinWindowHeight || x < -30000 || y < -30000 {
		return // 异常几何（窗口正在销毁/刚创建）不覆盖
	}
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = x, y, w, h, false
	a.store.SaveSettings(st)
}

// startupFile "发送到"/双击打开传入的命令行 md 路径。
var startupFile = func() string {
	for _, arg := range os.Args[1:] {
		if strings.EqualFold(filepath.Ext(arg), ".md") || strings.EqualFold(filepath.Ext(arg), ".markdown") {
			if abs, err := filepath.Abs(arg); err == nil {
				if _, err := os.Stat(abs); err == nil {
					return abs
				}
			}
		}
	}
	return ""
}()

// EmitOpenFile 通知前端打开一个文件（拖拽/二次实例共用）。
func (a *App) EmitOpenFile(path string) {
	if a.ctx == nil {
		return
	}
	wruntime.EventsEmit(a.ctx, "mdv:openfile", path)
}

// GetStartupFile 前端 mount 后拉取启动文件。
func (a *App) GetStartupFile() string { return startupFile }

// SetStartupFile 供二次实例启动时更新。
func (a *App) SetStartupFile(p string) { startupFile = p }

// OpenFolderDialog 选择目录。
func (a *App) OpenFolderDialog() (string, error) {
	return wruntime.OpenDirectoryDialog(a.ctx, wruntime.OpenDialogOptions{Title: "选择 Markdown 目录"})
}

// OpenFileDialog 选择 .md 文件。
func (a *App) OpenFileDialog() (string, error) {
	return wruntime.OpenFileDialog(a.ctx, wruntime.OpenDialogOptions{
		Title: "打开 Markdown 文件",
		Filters: []wruntime.FileFilter{
			{DisplayName: "Markdown (*.md)", Pattern: "*.md;*.markdown;*.mdown;*.mkd"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
}

// ListTree 目录树。
func (a *App) ListTree(dir string) ([]mdv.Node, error) { return a.store.ListTree(dir) }

// StatFile 判断文件是否仍存在（前端打开前的预检）。
// Wails 绑定只会把第一个返回值透传给 JS，因此这里只返回 bool。
func (a *App) StatFile(path string) bool {
	_, ok := a.store.StatFile(path)
	return ok
}

// ReadMarkdown 读取文件内容。
func (a *App) ReadMarkdown(path string) (mdv.FileContent, error) { return a.store.ReadMarkdown(path) }

// SaveMarkdown 把编辑后的正文写回文件（源码/对照模式的「保存」按钮）。
func (a *App) SaveMarkdown(path, content, encoding string) (mdv.FileContent, error) {
	return a.store.SaveMarkdown(path, content, encoding)
}

// FindByTitle wiki 链接解析。
func (a *App) FindByTitle(root, title string) string { return a.store.FindByTitle(root, title) }

// GetHistory / PushHistory / ClearHistory 历史。
func (a *App) GetHistory() []mdv.Entry             { return a.store.GetHistory() }
func (a *App) PushHistory(path string) []mdv.Entry { return a.store.PushHistory(path) }
func (a *App) ClearHistory() []mdv.Entry           { return a.store.ClearHistory() }

// GetFavorites / ToggleFavorite 收藏。
func (a *App) GetFavorites() []mdv.Entry { return a.store.GetFavorites() }
func (a *App) ToggleFavorite(path string) (bool, []mdv.Entry) {
	return a.store.ToggleFavorite(path)
}

// GetSettings / SaveSettings 设置。
func (a *App) GetSettings() mdv.Settings                { return a.store.GetSettings() }
func (a *App) SaveSettings(s mdv.Settings) mdv.Settings { return a.store.SaveSettings(s) }

// SetTheme 记录主题偏好（应用内配色由前端 data-theme 控制）。
func (a *App) SetTheme(theme string) {
	if theme != "dark" && theme != "light" {
		theme = "light"
	}
	st := a.store.GetSettings()
	st.Theme = theme
	a.store.SaveSettings(st)
}

// WindowPin 窗口置顶切换。
func (a *App) WindowPin(pin bool) { wruntime.WindowSetAlwaysOnTop(a.ctx, pin) }

// WindowMin / WindowMaxToggle / WindowClose 无边框窗口控制。
func (a *App) WindowMin()       { wruntime.WindowMinimise(a.ctx) }
func (a *App) WindowMaxToggle() { wruntime.WindowToggleMaximise(a.ctx) }
func (a *App) WindowClose()     { wruntime.Quit(a.ctx) }

// RestartApp 清除记住的窗口几何与侧栏宽度并重启进程（设置页「重启」）。
func (a *App) RestartApp() error {
	if a.restarting.Swap(true) { // 防重复点击拉起多个实例
		return nil
	}
	st := a.store.GetSettings()
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = 0, 0, 0, 0, false
	st.SidebarWidth = mdv.DefaultSidebarWidth
	a.store.SaveSettings(st)
	if err := a.launchSelf(); err != nil {
		a.restarting.Store(false) // 拉不起来就留在当前窗口，前端会提示错误
		return err
	}
	wruntime.Quit(a.ctx)
	return nil
}

// launchSelf 拉起新进程。新进程带 RelaunchFlag，由 main 等旧进程释放单实例锁后再启动。
func (a *App) launchSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{RelaunchFlag}
	for _, arg := range os.Args[1:] {
		if arg != RelaunchFlag { // 连续重启时不要把标记越叠越多
			args = append(args, arg)
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	return cmd.Start()
}

// WindowFullscreenToggle 全屏/退出全屏切换（标题栏 ⛶ 按钮）。
func (a *App) WindowFullscreenToggle() {
	if wruntime.WindowIsFullscreen(a.ctx) {
		wruntime.WindowUnfullscreen(a.ctx)
		return
	}
	wruntime.WindowFullscreen(a.ctx)
}

// CopyText 写入系统剪贴板（复制文件路径 / 复制代码块）。
func (a *App) CopyText(text string) { _ = wruntime.ClipboardSetText(a.ctx, text) }

// SetWindowTitle 同步系统任务栏标题。
func (a *App) SetWindowTitle(title string) { wruntime.WindowSetTitle(a.ctx, title) }

// RevealInShell 在资源管理器中显示文件所在目录。
func (a *App) RevealInShell(path string) {
	dir := filepath.Dir(path)
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("explorer", "/select,", path).Start()
	case "darwin":
		_ = exec.Command("open", "-R", path).Start()
	default:
		_ = exec.Command("xdg-open", dir).Start()
	}
}

// GetAssocState 读取 .md 文件关联状态（设置对话框用）。
func (a *App) GetAssocState() mdv.AssocState { return mdv.GetAssocState() }

// AssociateMd 把 .md/.markdown 关联到当前 mdview，并设置文件图标。
func (a *App) AssociateMd() error { return mdv.AssociateMd() }

// UnassociateMd 取消关联，还原接管前的默认打开方式。
func (a *App) UnassociateMd() error { return mdv.UnassociateMd() }

// SaveHtmlDialog 导出 HTML：弹保存框拿路径再落盘。
func (a *App) SaveHtmlDialog(title, html, defaultName string) (string, error) {
	if defaultName == "" {
		defaultName = "export.html"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".html"
	}
	target, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:           "导出 HTML",
		DefaultFilename: defaultName,
		Filters: []wruntime.FileFilter{
			{DisplayName: "HTML (*.html)", Pattern: "*.html"},
		},
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // 用户取消
	}
	return mdv.ExportHtml(title, html, target)
}

// SaveSvgDialog 导出思维导图 SVG：弹保存框拿路径后直接落盘（内容已是完整 SVG 文档）。
func (a *App) SaveSvgDialog(title, content, defaultName string) (string, error) {
	if defaultName == "" {
		defaultName = "mindmap.svg"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".svg"
	}
	target, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:           "导出 SVG",
		DefaultFilename: defaultName,
		Filters: []wruntime.FileFilter{
			{DisplayName: "SVG (*.svg)", Pattern: "*.svg"},
		},
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // 用户取消
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// SaveImageDialog 导出 PNG：前端把 SVG 光栅化为 data URL 后传回，解码并落盘。
func (a *App) SaveImageDialog(defaultName string, dataURL string) (string, error) {
	if defaultName == "" {
		defaultName = "mindmap.png"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".png"
	}
	target, err := wruntime.SaveFileDialog(a.ctx, wruntime.SaveDialogOptions{
		Title:           "导出 PNG",
		DefaultFilename: defaultName,
		Filters: []wruntime.FileFilter{
			{DisplayName: "PNG (*.png)", Pattern: "*.png"},
		},
	})
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil // 用户取消
	}
	comma := strings.Index(dataURL, ",")
	if comma < 0 {
		return "", fmt.Errorf("invalid data url")
	}
	if !strings.Contains(dataURL[:comma], "base64") {
		return "", fmt.Errorf("unsupported data url encoding")
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(target, raw, 0o644); err != nil {
		return "", err
	}
	return target, nil
}
