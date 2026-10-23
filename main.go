package main

import (
	"embed"
	"os"
	"strings"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	mdvapp "mdview/internal/app"
	"mdview/internal/mdv"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// 「重启」拉起的进程：旧进程还在退出，先等它释放单实例锁，
	// 否则新进程会被当成二次启动、把参数转交后直接退出
	if mdvapp.IsRelaunch(os.Args[1:]) {
		time.Sleep(1200 * time.Millisecond)
	}

	// 上次关闭时的窗口尺寸（位置与最大化在 app.Startup 里恢复）
	st := mdv.NewStore().GetSettings()
	width, height := mdv.DefaultWindowWidth, mdv.DefaultWindowHeight
	if st.WinW >= mdv.MinWindowWidth && st.WinH >= mdv.MinWindowHeight {
		width, height = st.WinW, st.WinH
	}

	app := mdvapp.NewApp()

	err := wails.Run(&options.App{
		Title:            "mdview",
		Width:            width,
		Height:           height,
		MinWidth:         mdv.MinWindowWidth,
		MinHeight:        mdv.MinWindowHeight,
		Frameless:        true, // 自绘标题栏（需求对齐官方 32px）
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: mdv.ImgHandler, // /mdimg/{hexpath} 本地图片回放
		},
		OnStartup:     app.Startup,
		OnBeforeClose: app.BeforeClose, // 关闭前记下窗口位置/大小
		DragAndDrop: &options.DragAndDrop{
			EnableFileDrop:     true,
			DisableWebViewDrop: false,
			CSSDropProperty:    "--wails-drop-target",
			CSSDropValue:       "drop",
		},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "mdview-2f7a1c90-8d4e-4f6b-9c3a-b58d1e2f7a10",
			OnSecondInstanceLaunch: func(data options.SecondInstanceData) {
				// 二次启动：把新文件转给已有窗口
				for _, arg := range data.Args {
					if l := strings.ToLower(arg); strings.HasSuffix(l, ".md") || strings.HasSuffix(l, ".markdown") {
						app.SetStartupFile(arg)
						app.EmitOpenFile(arg)
						return
					}
				}
			},
		},
		Windows: &windows.Options{
			WindowIsTranslucent:  false,
			WebviewIsTransparent: false,
			Theme:                windows.Light,
		},
		Bind: []interface{}{
			app,
		},
	})

	if err != nil {
		println("Error:", err.Error())
	}
}
