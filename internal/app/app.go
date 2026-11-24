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

	"mdview/internal/mdv"
)

// RelaunchFlag 「重启」拉起新进程时附加的标记：main 见到它先等旧进程退出，
// 否则新进程会撞上单实例锁，被当成二次启动转交后直接退出。
const RelaunchFlag = "--mdview-relaunch"

// BuildDate 编译时间（UTC），由 build.ps1 经 -ldflags -X 注入；开发态为 "dev"。
var BuildDate = "dev"

// WaitPidFlagPrefix 旧进程 PID 参数：新进程轮询该 PID 退出后再启动，
// 替代固定 sleep——慢机器上 1.2s 未必够，快机器上白等。
const WaitPidFlagPrefix = "--mdview-wait-pid="

// IsRelaunch 判断本进程是否由设置页「重启」拉起。
func IsRelaunch(args []string) bool {
	for _, arg := range args {
		if arg == RelaunchFlag {
			return true
		}
	}
	return false
}

// WaitPidOf 从命令行参数解析要等待退出的旧进程 PID；没有则返回 0。
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

// ProcessAlive 判断 pid 对应的进程是否仍在运行（Windows 用 OpenProcess 探测）。
func ProcessAlive(pid int) bool { return processAlive(pid) }

// App Wails Service：前端可调用的全部方法挂在这里。
// v3 用 Service 模式替代 v2 的 Bind + ctx：运行期对象经 ServiceStartup 拿到。
type App struct {
	app        *application.App
	win        *application.WebviewWindow
	store      *mdv.Store
	restarting atomic.Bool // 重启中：关闭前不能再把当前几何写回设置
	draftDirty atomic.Bool // 前端有未保存草稿：关闭拦截先让前端弹确认
}

var singleton *App

func NewApp() *App {
	a := &App{store: mdv.NewStore()}
	singleton = a
	return a
}

// Instance 返回唯一的 App Service 实例（main.go 的 SingleInstance 回调使用）。
func Instance() *App {
	if singleton == nil {
		return NewApp()
	}
	return singleton
}

// ServiceStartup Wails 生命周期回调（v2 的 Startup）。
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	a.app = application.Get()
	// 外部文件修改监视：mdv 检测到变化后经 Wails 事件推给前端
	a.store.SetFileChangeCallback(func(ev mdv.FileEvent) {
		a.app.Event.Emit("file:watch", ev)
	})
	return nil
}

// SetWindow 由 main 在创建窗口后注入；Service 启动早于 Run，无法在回调里创建。
func (a *App) SetWindow(w *application.WebviewWindow) {
	a.win = w
}

// OnWindowClosing 关闭拦截（对应 v2 的 BeforeClose）：
// Windows 上标题栏 ✕ / Alt+F4 触发 WM_CLOSE → Windows.WindowClosing，此时窗口
// 尚未真正关闭，放行须显式调 win.Close()。有未保存草稿时先取消关闭并让前端
// 弹确认；用户确认后前端清标志再调 WindowClose（走 Quit）。
// 无草稿则记录几何后放行。
func (a *App) OnWindowClosing(win *application.WebviewWindow) {
	if a.draftDirty.Load() {
		a.app.Event.Emit("draft:close-request")
		return // 本次 WM_CLOSE 被否决，等待前端决定
	}
	a.saveWindowState(win)
	win.Close()
}

// SetDraftDirty 由前端同步「是否有未保存草稿」；关闭确认桥使用。
func (a *App) SetDraftDirty(dirty bool) {
	a.draftDirty.Store(dirty)
}

// AllowImageDir 登记允许通过 /mdimg 回放的目录；打开图片 / 启动恢复均需 await 后再显示。
func (a *App) AllowImageDir(dir string) {
	mdv.AllowImageDir(dir)
}

// saveWindowState 只记录可还原的普通窗口几何：
// 最大化时保留上次普通尺寸只置标记，最小化/全屏时坐标不可靠则原样保留。
func (a *App) saveWindowState(win *application.WebviewWindow) {
	if a.restarting.Load() { // 重启已主动清空几何，不能再写回去
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
	if w < mdv.MinWindowWidth || h < mdv.MinWindowHeight || x < -30000 || y < -30000 {
		return // 异常几何（窗口正在销毁/刚创建）不覆盖
	}
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = x, y, w, h, false
	a.store.SaveSettings(st)
}

// startupFile "发送到"/双击打开传入的命令行 md 路径。
// 二次实例 goroutine 写、前端绑定 goroutine 读，用 atomic.Pointer 同步。
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

// EmitOpenFile 通知前端打开一个文件（拖拽/二次实例共用）。
func (a *App) EmitOpenFile(path string) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit("mdv:openfile", path)
}

// BringToFront 把已有窗口带到前台：二次启动（双击关联 .md 文件）时已有实例在后台
// 运行，只把文件转给它的话，用户看到的是「什么都没发生」。最小化则还原，后台则置前。
// 走 Wails 的 WindowShow——它内部派发到创建窗口的主线程
// （窗口 API 跨线程调用会直接崩溃），并自带 SetForegroundWindow + SetFocus。
func (a *App) BringToFront() {
	if a.win == nil {
		return
	}
	a.win.Show()
}

// GetStartupFile 前端 mount 后拉取启动文件。
func (a *App) GetStartupFile() string {
	if p := startupFile.Load(); p != nil {
		return *p
	}
	return ""
}

// BuildInfo 设置页底部显示的编译信息（编译时间，build.ps1 注入）。
func (a *App) BuildInfo() string { return BuildDate }

// SetStartupFile 供二次实例启动时更新。
func (a *App) SetStartupFile(p string) {
	startupFile.Store(&p)
}

// dialogTitle 原生对话框标题跟随设置语言，避免切到英/日/德仍显示中文。
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

// OpenFolderDialog 选择目录（v3 目录选择走 OpenFile 对话框的 CanChooseDirectories）。
func (a *App) OpenFolderDialog() (string, error) {
	return a.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		Title:                a.dialogTitle("选择 Markdown 目录", "Select Markdown folder", "Markdown フォルダーを選択", "Markdown-Ordner auswählen"),
	}).PromptForSingleSelection()
}

// OpenFileDialog 选择 .md 文件。
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

// ListTree 目录树（带 2s 缓存）。
func (a *App) ListTree(dir string) ([]mdv.Node, error) { return a.store.ListTree(dir) }

// RefreshTree 显式刷新：先失效缓存再扫描磁盘。
func (a *App) RefreshTree(dir string) ([]mdv.Node, error) {
	mdv.InvalidateTreeCache()
	return a.store.ListTree(dir)
}

// StatFile 判断文件是否仍存在（前端打开前的预检）。
// Wails 绑定只会把第一个返回值透传给 JS，因此这里只返回 bool。
func (a *App) StatFile(path string) bool {
	_, ok := a.store.StatFile(path)
	return ok
}

// ReadMarkdown 读取文件内容，并切换外部修改监视到该文件。
func (a *App) ReadMarkdown(path string) (mdv.FileContent, error) {
	fc, err := a.store.ReadMarkdown(path)
	if err == nil {
		a.store.WatchFile(path)
	}
	return fc, err
}

// SaveMarkdown 把编辑后的正文写回文件（源码/对照模式的「保存」按钮）。
func (a *App) SaveMarkdown(path, content, encoding string) (mdv.FileContent, error) {
	fc, err := a.store.SaveMarkdown(path, content, encoding)
	if err == nil {
		// 标记自身写入，watcher 不会把这次保存当成外部修改广播；
		// 已删除文件被重建后也重新挂接监视（resolveGoneFile 曾 StopWatch）
		a.store.MarkSaved()
		a.store.WatchFile(path)
	}
	return fc, err
}

// FindByTitle / FindByTitles 同名标题索引（目录树跳转用）。
func (a *App) FindByTitle(root, title string) string    { return a.store.FindByTitle(root, title) }
func (a *App) FindByTitles(root, title string) []string { return a.store.FindByTitles(root, title) }

// 历史 / 收藏。
func (a *App) GetHistory() []mdv.Entry   { return a.store.GetHistory() }
func (a *App) PushHistory(path string)   { a.store.PushHistory(path) }
func (a *App) ClearHistory()             { a.store.ClearHistory() }
func (a *App) RemoveHistory(path string) { a.store.RemoveHistory(path) }

func (a *App) GetFavorites() []mdv.Entry { return a.store.GetFavorites() }

// ToggleFavorite 切换收藏。只回传切换后的状态，列表由前端经 GetFavorites 刷新。
func (a *App) ToggleFavorite(path string) bool {
	added, _ := a.store.ToggleFavorite(path)
	return added
}

func (a *App) GetSettings() mdv.Settings                { return a.store.GetSettings() }
func (a *App) SaveSettings(s mdv.Settings) mdv.Settings { return a.store.SaveSettings(s) }
func (a *App) GetLastError() string                     { return a.store.LastError() }

// SetTheme 记录主题偏好（应用内配色由前端 data-theme 控制）。
func (a *App) SetTheme(theme string) {
	if theme != "dark" && theme != "light" {
		theme = "light"
	}
	st := a.store.GetSettings()
	st.Theme = theme
	a.store.SaveSettings(st)
}

// WindowPin / WindowMin / WindowMaxToggle 无边框窗口控制。
func (a *App) WindowPin(pin bool) { a.win.SetAlwaysOnTop(pin) }
func (a *App) WindowMin()         { a.win.Minimise() }
func (a *App) WindowMaxToggle()   { a.win.ToggleMaximise() }
func (a *App) WindowClose()       { a.app.Quit() }

// RestartApp 清除记住的窗口几何与侧栏宽度并重启进程（设置页「重启」）。
func (a *App) RestartApp() error {
	if a.restarting.Swap(true) { // 防重复点击拉起多个实例
		return nil
	}
	a.draftDirty.Store(false) // 前端已确认丢弃草稿，别让关闭拦截再弹一次
	st := a.store.GetSettings()
	st.WinX, st.WinY, st.WinW, st.WinH, st.WinMax = 0, 0, 0, 0, false
	st.SidebarWidth = mdv.DefaultSidebarWidth
	a.store.SaveSettings(st)
	if err := a.launchSelf(); err != nil {
		a.restarting.Store(false) // 拉不起来就留在当前窗口，前端会提示错误
		return err
	}
	a.app.Quit()
	return nil
}

// launchSelf 拉起新进程。新进程带 RelaunchFlag 与旧进程 PID，
// 由 main 轮询等旧进程退出（释放单实例锁）后再启动。
func (a *App) launchSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	args := []string{RelaunchFlag, fmt.Sprintf("%s%d", WaitPidFlagPrefix, os.Getpid())}
	for _, arg := range os.Args[1:] {
		if arg != RelaunchFlag && !strings.HasPrefix(arg, WaitPidFlagPrefix) { // 连续重启时不要把标记越叠越多
			args = append(args, arg)
		}
	}
	cmd := exec.Command(exe, args...)
	cmd.Dir = filepath.Dir(exe)
	return cmd.Start()
}

// WindowFullscreenToggle 全屏/退出全屏切换（标题栏 ⛶ 按钮）。
func (a *App) WindowFullscreenToggle() {
	a.win.ToggleFullscreen()
}

// CopyText 写入系统剪贴板（复制文件路径 / 复制代码块）。
func (a *App) CopyText(text string) { _ = a.app.Clipboard.SetText(text) }

// SetWindowTitle 同步系统任务栏标题。
func (a *App) SetWindowTitle(title string) { a.win.SetTitle(title) }

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
