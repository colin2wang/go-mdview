//go:build windows

package win

import (
	"golang.org/x/sys/windows"
)

// ProcessAlive 探测 pid 是否仍在运行：OpenProcess 成功不代表进程还活着
// （未回收的退出进程句柄仍可打开），再用 WaitForSingleObject(0) 确认退出状态。
// Windows 下等旧进程退出用（重启时释放单实例锁）。
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
