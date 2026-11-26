//go:build !windows

package win

import "errors"

// CopyImage 非 Windows 平台未实现位图剪贴板（项目主目标为 Windows）。
func CopyImage(_ string) error {
	return errors.New("image clipboard is only supported on Windows")
}
