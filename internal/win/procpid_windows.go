//go:build windows

package win

import (
	"golang.org/x/sys/windows"
)

// ProcessAlive reports whether the pid is still running. OpenProcess success
// alone is not enough (handles of unreaped exited processes still open), so
// WaitForSingleObject(0) confirms the exit status.
func ProcessAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	status, err := windows.WaitForSingleObject(h, 0)
	if err != nil {
		return err == windows.WAIT_TIMEOUT
	}
	return status == uint32(windows.WAIT_TIMEOUT)
}
