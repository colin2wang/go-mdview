package mdv

// AssocState 文件关联状态（供设置对话框展示）。
type AssocState struct {
	Supported  bool   `json:"supported"`  // 当前平台是否支持关联（目前仅 Windows）
	ExePath    string `json:"exePath"`    // 当前可执行文件路径
	Associated bool   `json:"associated"` // .md 是否已指向 mdview
	Owner      string `json:"owner"`      // 未关联时的当前默认打开方式；空串表示未设置（文案由前端 i18n 的 assoc.ownerNone 提供）
	Message    string `json:"message"`    // 最近一次操作的说明/错误
}
