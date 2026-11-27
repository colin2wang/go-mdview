//go:build !windows

package win

import "errors"

// CopyImage is unimplemented on non-Windows platforms.
func CopyImage(_ string) error {
	return errors.New("image clipboard is only supported on Windows")
}
