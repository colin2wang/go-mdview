//go:build !windows

package mdv

import "errors"

// errAssocUnsupported 非 Windows 平台不支持写注册表关联。
var errAssocUnsupported = errors.New("文件关联仅支持 Windows")

// ExePath 当前可执行文件路径。
func ExePath() string { return "" }

// GetAssocState 非 Windows：明确告知不支持，避免前端给出可点击的无效按钮。
func GetAssocState() AssocState {
	return AssocState{Supported: false, Owner: "（未设置）", Message: errAssocUnsupported.Error()}
}

// AssociateMd 非 Windows：不支持。
func AssociateMd() error { return errAssocUnsupported }

// UnassociateMd 非 Windows：不支持。
func UnassociateMd() error { return errAssocUnsupported }
