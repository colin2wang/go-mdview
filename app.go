package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"

	"mdview/mdv"
)

// App Wails 绑定层：前端可调用的全部方法挂在这里。
type App struct {
	ctx   context.Context
	store *mdv.Store
}

func NewApp() *App { return &App{store: mdv.NewStore()} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// 拖拽 .md 打开由前端 JS runtime.OnFileDrop 处理（store.ts initApp）：
	// Windows 上 Go 端 OnFileDrop 必须依赖 JS 端监听才会触发（Wails v2 #3985），
	// 为避免同一次 drop 双路触发，这里不再重复注册。
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

// emitOpenFile 通知前端打开一个文件（拖拽/二次实例共用）。
func (a *App) emitOpenFile(path string) {
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
