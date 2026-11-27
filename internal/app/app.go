package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"

	"mdview/internal/assoc"
	"mdview/internal/exporter"
	"mdview/internal/imgsrv"
	"mdview/internal/settings"
	"mdview/internal/storage"
	"mdview/internal/win"
)

// RelaunchFlag marks a process started from the settings-page restart action;
// main waits for the old process to exit before continuing startup.
const RelaunchFlag = "--mdview-relaunch"

// BuildDate is the build time (UTC), injected by build.ps1 via -ldflags -X; "dev" when unstripped.
var BuildDate = "dev"

// BuildVersion is the main version, injected by build.ps1 via -ldflags -X; "dev" when unstripped.
var BuildVersion = "dev"

// WaitPidFlagPrefix carries the old process PID; the new process polls it
// until exit before continuing, instead of sleeping a fixed duration.
const WaitPidFlagPrefix = "--mdview-wait-pid="

// IsRelaunch reports whether this process was started by the restart action.
func IsRelaunch(args []string) bool {
	for _, arg := range args {
		if arg == RelaunchFlag {
			return true
		}
	}
	return false
}

// WaitPidOf parses the old process PID to wait for from the command line; returns 0 if absent.
func WaitPidOf(args []string) int {
	for _, arg := range args {
		if p, ok := strings.CutPrefix(arg, WaitPidFlagPrefix); ok {
			if n, err := strconv.Atoi(p); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

// ProcessAlive reports whether the process with the given pid is still running.
func ProcessAlive(pid int) bool { return win.ProcessAlive(pid) }

// App is the Wails Service exposing every method callable from the frontend.
type App struct {
	app        *application.App
	win        *application.WebviewWindow
	store      *storage.Store
	restarting atomic.Bool // restart in progress; window geometry must not be written back
	draftDirty atomic.Bool // frontend has an unsaved draft; close interception asks it first
}

var singleton *App

func NewApp() *App {
	a := &App{store: storage.NewStore()}
	singleton = a
	return a
}

// Instance returns the single App Service instance (used by the single-instance callback).
func Instance() *App {
	if singleton == nil {
		return NewApp()
	}
	return singleton
}

// ServiceStartup is the Wails lifecycle callback.
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	a.app = application.Get()
	a.store.SetFileChangeCallback(func(ev storage.FileEvent) {
		a.app.Event.Emit("file:watch", ev)
	})
	return nil
}

// ServiceShutdown stops file watching on exit (Wails lifecycle callback).
func (a *App) ServiceShutdown() error {
	a.store.StopWatch()
	return nil
}

// SetWindow injects the main window after it has been created by main.
func (a *App) SetWindow(w *application.WebviewWindow) {
	a.win = w
}

// OnWindowClosing intercepts window close: with an unsaved draft it cancels the
// close and asks the frontend to confirm; otherwise the window geometry is saved
// and the close allowed.
func (a *App) OnWindowClosing(win *application.WebviewWindow) {
	if a.draftDirty.Load() {
		a.app.Event.Emit("draft:close-request")
		return
	}
	a.saveWindowState(win)
	win.Close()
}

// SetDraftDirty receives the "has unsaved draft" flag from the frontend.
func (a *App) SetDraftDirty(dirty bool) {
	a.draftDirty.Store(dirty)
}

// AllowImageDir registers a directory whose images may be replayed via /mdimg.
func (a *App) AllowImageDir(dir string) {
	imgsrv.AllowImageDir(dir)
}

// saveWindowState records restorable normal window geometry only: when
// maximized only the flag is set, minimized/fullscreen states are skipped.
func (a *App) saveWindowState(win *application.WebviewWindow) {
	if a.restarting.Load() {
		return
	}
	st := a.store.GetSettings()
	switch {
	case win.IsFullscreen(), win.IsMinimised():
		return
	case win.IsMaximised():
		st.WinMax = true
		a.store.SaveSettings(st)
		return
	}
	x, y := win.Position()
	w, h := win.Size()
	if w < settings.MinWindowWidth || h < settings.MinWindowHeight || x < -30000 || y < -30000 {
		return
	}
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = x, y, w, h, false
	a.store.SaveSettings(st)
}

// startupFile holds the .md path passed via command line / second instance.
// Written by the second-instance goroutine and read by frontend bindings,
// so it is synchronized with atomic.Pointer.
var startupFile atomic.Pointer[string]

func init() {
	startupFile.Store(func() *string {
		for _, arg := range os.Args[1:] {
			if strings.EqualFold(filepath.Ext(arg), ".md") || strings.EqualFold(filepath.Ext(arg), ".markdown") {
				if abs, err := filepath.Abs(arg); err == nil {
					if _, err := os.Stat(abs); err == nil {
						return &abs
					}
				}
			}
		}
		p := ""
		return &p
	}())
}

// EmitOpenFile tells the frontend to open a file (drag & drop / second instance).
func (a *App) EmitOpenFile(path string) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit("mdv:openfile", path)
}

// BringToFront raises the existing window after a second launch.
func (a *App) BringToFront() {
	if a.win == nil {
		return
	}
	a.win.Show()
}

// GetStartupFile returns the file the frontend should open on mount.
func (a *App) GetStartupFile() string {
	if p := startupFile.Load(); p != nil {
		return *p
	}
	return ""
}

// BuildInfo returns the version + build time shown on the settings page.
func (a *App) BuildInfo() string {
	if BuildVersion == "dev" && BuildDate == "dev" {
		return "dev"
	}
	return BuildVersion + " build " + BuildDate
}

// SetStartupFile updates the startup file when a second instance hands over.
func (a *App) SetStartupFile(p string) {
	startupFile.Store(&p)
}

// dialogTitle picks a native dialog title according to the configured language.
func (a *App) dialogTitle(zh, en, ja, de string) string {
	switch a.store.GetSettings().Language {
	case "en":
		return en
	case "ja":
		return ja
	case "de":
		return de
	default:
		return zh
	}
}

// OpenFolderDialog selects a Markdown directory.
func (a *App) OpenFolderDialog() (string, error) {
	return a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		Title:                a.dialogTitle("选择 Markdown 目录", "Select Markdown folder", "Markdown フォルダーを選択", "Markdown-Ordner auswählen"),
	}).PromptForSingleSelection()
}

// OpenFileDialog selects a .md file.
func (a *App) OpenFileDialog() (string, error) {
	return a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseFiles: true,
		Title:          a.dialogTitle("打开 Markdown 文件", "Open Markdown file", "Markdown ファイルを開く", "Markdown-Datei öffnen"),
		Filters: []application.FileFilter{
			{DisplayName: "Markdown (*.md)", Pattern: "*.md;*.markdown;*.mdown;*.mkd"},
			{DisplayName: a.dialogTitle("所有文件 (*.*)", "All files (*.*)", "すべてのファイル (*.*)", "Alle Dateien (*.*)"), Pattern: "*.*"},
		},
	}).PromptForSingleSelection()
}

// ListTree scans the directory tree (cached for 2s).
func (a *App) ListTree(dir string) ([]storage.Node, error) { return a.store.ListTree(dir) }

// RefreshTree invalidates the cache and rescans the disk.
func (a *App) RefreshTree(dir string) ([]storage.Node, error) {
	storage.InvalidateTreeCache()
	return a.store.ListTree(dir)
}

// StatFile checks whether a file still exists (pre-open check by the frontend).
func (a *App) StatFile(path string) bool {
	_, ok := a.store.StatFile(path)
	return ok
}

// ReadMarkdown reads a file and moves external-modify watching to it.
func (a *App) ReadMarkdown(path string) (storage.FileContent, error) {
	fc, err := a.store.ReadMarkdown(path)
	if err == nil {
		a.store.WatchFile(path)
	}
	return fc, err
}

// SaveMarkdown writes edited content back to the file.
func (a *App) SaveMarkdown(path, content, encoding string) (storage.FileContent, error) {
	fc, err := a.store.SaveMarkdown(path, content, encoding)
	if err == nil {
		a.store.MarkSaved()
		a.store.WatchFile(path)
	}
	return fc, err
}

// FindByTitle / FindByTitles resolve same-name titles (used by the tree).
func (a *App) FindByTitle(root, title string) string    { return a.store.FindByTitle(root, title) }
func (a *App) FindByTitles(root, title string) []string { return a.store.FindByTitles(root, title) }

// History endpoints.
func (a *App) GetHistory() []storage.Entry { return a.store.GetHistory() }
func (a *App) PushHistory(path string)     { a.store.PushHistory(path) }
func (a *App) ClearHistory()               { a.store.ClearHistory() }
func (a *App) RemoveHistory(path string)   { a.store.RemoveHistory(path) }

// Favorites endpoints.
func (a *App) GetFavorites() []storage.Entry { return a.store.GetFavorites() }

// ToggleFavorite toggles a favorite; the list is refreshed via GetFavorites.
func (a *App) ToggleFavorite(path string) bool {
	added, _ := a.store.ToggleFavorite(path)
	return added
}

// Settings endpoints.
func (a *App) GetSettings() settings.Settings { return a.store.GetSettings() }
func (a *App) SaveSettings(s settings.Settings) settings.Settings {
	current := a.store.GetSettings()
	s.WinX, s.WinY, s.WinW, s.WinH, s.WinMax = current.WinX, current.WinY, current.WinW, current.WinH, current.WinMax
	return a.store.SaveSettings(s)
}
func (a *App) GetLastError() string { return a.store.LastError() }

// SetTheme persists the theme preference (colors are applied by the frontend).
func (a *App) SetTheme(theme string) {
	if theme != "dark" && theme != "light" {
		theme = "light"
	}
	st := a.store.GetSettings()
	st.Theme = theme
	a.store.SaveSettings(st)
}

// Frameless window controls.
func (a *App) WindowPin(pin bool) { a.win.SetAlwaysOnTop(pin) }
func (a *App) WindowMin()         { a.win.Minimise() }
func (a *App) WindowMaxToggle()   { a.win.ToggleMaximise() }

// WindowClose is the unified exit used by the custom title bar and the draft
// confirmation; window geometry is saved explicitly before quitting.
func (a *App) WindowClose() {
	if a.win != nil {
		a.saveWindowState(a.win)
	}
	a.app.Quit()
}

// RestartApp resets remembered window geometry and sidebar width, then restarts.
func (a *App) RestartApp() error {
	if a.restarting.Swap(true) {
		return nil
	}
	a.draftDirty.Store(false)
	st := a.store.GetSettings()
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = 0, 0, 0, 0, false
	st.SidebarWidth = settings.DefaultSidebarWidth
	a.store.SaveSettings(st)
	if err := a.launchSelf(); err != nil {
		a.restarting.Store(false)
		return err
	}
	a.app.Quit()
	return nil
}

// launchSelf starts a new process with RelaunchFlag and this process's PID;
// main polls the old process until it exits (releasing the single-instance lock).
func (a *App) launchSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{RelaunchFlag, fmt.Sprintf("%s%d", WaitPidFlagPrefix, os.Getpid())}
	for _, arg := range os.Args[1:] {
		if arg != RelaunchFlag && !strings.HasPrefix(arg, WaitPidFlagPrefix) {
			args = append(args, arg)
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	return cmd.Start()
}

// WindowFullscreenToggle switches fullscreen on or off.
func (a *App) WindowFullscreenToggle() {
	a.win.ToggleFullscreen()
}

// CopyText writes text to the system clipboard.
func (a *App) CopyText(text string) { _ = a.app.Clipboard.SetText(text) }

// CopyImage writes a rasterized PNG data URL to the clipboard as a bitmap.
func (a *App) CopyImage(dataURL string) error { return win.CopyImage(dataURL) }

// OpenExternalURL opens a link in the system browser; only http/https/mailto
// are allowed so untrusted documents cannot abuse other schemes.
func (a *App) OpenExternalURL(url string) error {
	if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "mailto:") {
		return fmt.Errorf("unsupported URL scheme")
	}
	return a.app.Browser.OpenURL(url)
}

// SetWindowTitle syncs the taskbar title.
func (a *App) SetWindowTitle(title string) { a.win.SetTitle(title) }

// RevealInShell shows the file's directory in the system file manager.
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

// GetAssocState reads the .md file association state (settings dialog).
func (a *App) GetAssocState() assoc.AssocState { return assoc.GetAssocState() }

// AssociateMd associates .md/.markdown with this mdview and sets the file icon.
func (a *App) AssociateMd() error { return assoc.AssociateMd() }

// UnassociateMd removes the association and restores the previous handler.
func (a *App) UnassociateMd() error { return assoc.UnassociateMd() }

// SaveHtmlDialog asks for a target path and writes the exported HTML.
func (a *App) SaveHtmlDialog(title, html, defaultName string) (string, error) {
	if defaultName == "" {
		defaultName = "export.html"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".html"
	}
	target, err := a.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    a.dialogTitle("导出 HTML", "Export HTML", "HTML を書き出す", "HTML exportieren"),
		Filename: defaultName,
		Filters: []application.FileFilter{
			{DisplayName: "HTML (*.html)", Pattern: "*.html"},
		},
	}).PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil
	}
	return exporter.ExportHtml(title, html, target)
}

// SaveSvgDialog asks for a target path and writes an SVG document.
func (a *App) SaveSvgDialog(title, content, defaultName string) (string, error) {
	if defaultName == "" {
		defaultName = "mindmap.svg"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".svg"
	}
	target, err := a.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    a.dialogTitle("导出 SVG", "Export SVG", "SVG を書き出す", "SVG exportieren"),
		Filename: defaultName,
		Filters: []application.FileFilter{
			{DisplayName: "SVG (*.svg)", Pattern: "*.svg"},
		},
	}).PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return target, nil
}

// SaveImageDialog decodes a rasterized PNG data URL and writes it to disk.
func (a *App) SaveImageDialog(defaultName string, dataURL string) (string, error) {
	if defaultName == "" {
		defaultName = "mindmap.png"
	}
	if filepath.Ext(defaultName) == "" {
		defaultName += ".png"
	}
	target, err := a.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    a.dialogTitle("导出 PNG", "Export PNG", "PNG を書き出す", "PNG exportieren"),
		Filename: defaultName,
		Filters: []application.FileFilter{
			{DisplayName: "PNG (*.png)", Pattern: "*.png"},
		},
	}).PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if target == "" {
		return "", nil
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
