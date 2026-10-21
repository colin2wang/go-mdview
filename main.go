package main

import (
	"embed"
	"strings"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"

	"mdview/mdv"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:            "mdview",
		Width:            1200,
		Height:           800,
		MinWidth:         720,
		MinHeight:        420,
		Frameless:        true, // 自绘标题栏（需求对齐官方 32px）
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 255},
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: mdv.ImgHandler, // /mdimg/{hexpath} 本地图片回放
		},
		OnStartup: app.startup,
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
						app.emitOpenFile(arg)
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
