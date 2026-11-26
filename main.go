package main

import (
	"embed"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	mdvapp "mdview/internal/app"
	"mdview/internal/imgsrv"
	"mdview/internal/settings"
	"mdview/internal/storage"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// 「重启」拉起的进程：旧进程还在退出，先等它退出（释放单实例锁），
	// 否则新进程会被当成二次启动、把参数转交后直接退出。
	// 轮询旧进程 PID（--mdview-wait-pid），替代固定 sleep：慢机器 1.2s 未必够，快机器白等。
	if pid := mdvapp.WaitPidOf(os.Args[1:]); pid != 0 {
		deadline := time.Now().Add(5 * time.Second) // 兜底上限，卡死也不无限等
		for mdvapp.ProcessAlive(pid) && time.Now().Before(deadline) {
			time.Sleep(50 * time.Millisecond)
		}
	}

	// 上次关闭时的窗口几何（尺寸 + 位置 + 最大化都由 settings 记忆）
	st := storage.NewStore().GetSettings()
	width, height := settings.DefaultWindowWidth, settings.DefaultWindowHeight
	if st.WinW >= settings.MinWindowWidth && st.WinH >= settings.MinWindowHeight {
		width, height = st.WinW, st.WinH
	}

	wailsApp := application.New(application.Options{
		Name: "mdview",
		Services: []application.Service{
			application.NewService(mdvapp.NewApp()),
		},
		Assets: application.AssetOptions{
			Handler: assetHandler(),
		},
		SingleInstance: &application.SingleInstanceOptions{
			// 沿用 v2 SingleInstanceLock.UniqueId，保证新旧版本互踢逻辑不变
			UniqueID: "mdview-2f7a1c90-8d4e-4f6b-9c3a-b58d1e2f7a10",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				// 二次启动跑在已有实例里：先把已有窗口带到前台（程序在后台/最小化时
				// 只是默默切了文件，用户看不到），再把新文件转给它
				app := mdvapp.Instance()
				app.BringToFront()
				for _, arg := range data.Args {
					l := strings.ToLower(arg)
					if strings.HasSuffix(l, ".md") || strings.HasSuffix(l, ".markdown") ||
						strings.HasSuffix(l, ".mdown") || strings.HasSuffix(l, ".mkd") {
						app.SetStartupFile(arg)
						app.EmitOpenFile(arg)
						return
					}
				}
			},
		},
	})

	win := wailsApp.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:     "mdview",
		X:         st.WinX,
		Y:         st.WinY,
		Width:     width,
		Height:    height,
		MinWidth:  settings.MinWindowWidth,
		MinHeight: settings.MinWindowHeight,
		// 自绘标题栏（需求对齐官方 32px）；v3 默认 StartState 为普通态
		Frameless: true,
		// 原生拖放默认关闭，必须显式开启：Go 侧接住后转发前端
		EnableFileDrop: true,
		StartState: func() application.WindowState {
			if st.WinMax {
				return application.WindowStateMaximised
			}
			return application.WindowStateNormal
		}(),
	})

	app := mdvapp.Instance()
	app.SetWindow(win)

	// 关闭拦截（Windows：标题栏 ✕ / Alt+F4 触发 WM_CLOSE → Windows.WindowClosing，
	// 此时窗口并未真正关闭；放行须显式调 win.Close()）：
	// 有未保存草稿时先转发前端弹确认；无草稿则记录几何后放行。
	win.OnWindowEvent(events.Windows.WindowClosing, func(e *application.WindowEvent) {
		app.OnWindowClosing(win)
	})

	// 原生拖放：Go 侧拿到绝对路径后转发前端，由 store.ts 分发打开
	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		paths := e.Context().DroppedFiles()
		wailsApp.Event.Emit("mdv:files-dropped", paths)
	})

	err := wailsApp.Run()
	if err != nil {
		println("Error:", err.Error())
	}
}

// assetHandler 静态资产 + 本地图片回放分流：
// /mdimg/{hexpath} 直连 imgsrv.ImgHandler（目录白名单校验），其余走内嵌前端资产。
func assetHandler() http.Handler {
	fileServer := application.BundledAssetFileServer(assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/mdimg/") {
			imgsrv.ImgHandler.ServeHTTP(w, r)
			return
		}
		fileServer.ServeHTTP(w, r)
	})
}
