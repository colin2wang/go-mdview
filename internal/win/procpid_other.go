//go:build !windows

package win

import (
	"syscall"
)

// ProcessAlive reports whether the pid is still running (signal 0 probes
// without delivering a signal).
func ProcessAlive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
