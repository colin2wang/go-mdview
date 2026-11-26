//go:build !windows

package app

import "errors"

// copyImageToClipboard 非 Windows 平台未实现位图剪贴板（项目主目标为 Windows）。
func copyImageToClipboard(_ string) error {
	return errors.New("image clipboard is only supported on Windows")
}
