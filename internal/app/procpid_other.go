//go:build !windows

package app

import (
	"syscall"
)

// processAlive 探测 pid 是否仍在运行：kill 信号 0 不投递、只探测。
func processAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
