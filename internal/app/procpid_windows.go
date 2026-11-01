//go:build windows

package app

import (
	"golang.org/x/sys/windows"
)

// processAlive 探测 pid 是否仍在运行：OpenProcess 成功即认为存活。
// Windows 下等旧进程退出用（重启时释放单实例锁）。
func processAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}
