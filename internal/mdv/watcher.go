package mdv

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// FileEvent 外部文件事件：changed = 内容可能变化，gone = 文件被删除/改名。
type FileEvent struct {
	Kind    string `json:"kind"` // changed | gone
	Path    string `json:"path"`
	ModTime int64  `json:"modTime"` // changed 事件时为最新 mtime（UnixMilli）
	Size    int64  `json:"size"`
}

// 事件防抖与自身写入抑制窗口。
const (
	watchDebounce     = 400 * time.Millisecond
	saveSuppressAfter = 2 * time.Second
)

// watcherState Store 的文件监视部分。事件经 callback 抛给上层（App 负责转成 Wails 事件）。
type watcherState struct {
	mu        sync.Mutex
	w         *fsnotify.Watcher
	watched   string        // 当前监视的文件路径（Clean 后）
	knownM    int64         // 打开/上次刷新时的 mtime
	knownS    int64         // 打开/上次刷新时的 size
	savedAt   time.Time     // 本应用最后一次保存时间
	savedHash string        // 本应用最后一次保存的内容哈希：只有内容相同才抑制自身写入
	stop      chan struct{} // 事件循环退出信号
	onChange  func(FileEvent)
}

// SetFileChangeCallback 注册事件回调，须在 WatchFile 之前调用。
func (s *Store) SetFileChangeCallback(cb func(FileEvent)) {
	s.watcher.mu.Lock()
	defer s.watcher.mu.Unlock()
	s.watcher.onChange = cb
}

// WatchFile 监视 path 的外部修改；切换文件时自动替换旧的监视目标。
// 编辑器保存常见「临时文件→重命名」，监视目标会随 rename 失效，所以每次都重建监视。
func (s *Store) WatchFile(path string) {
	path = filepath.Clean(path)
	st := &s.watcher
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.watched == path {
		// 同一文件重复打开：刷新已知 mtime/size，避免旧值导致首次事件误报
		if fi, err := os.Stat(path); err == nil {
			st.knownM, st.knownS = fi.ModTime().UnixMilli(), fi.Size()
		}
		return
	}
	s.watcherStopLocked()

	w, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	// 目录级监视：Windows 上对文件 Add 在文件被整体替换（rename 覆盖）后会失效，
	// 监视所在目录才能在文件被重建后继续收到事件
	_ = w.Add(filepath.Dir(path))
	st.w = w
	st.watched = path
	if fi, err := os.Stat(path); err == nil {
		st.knownM, st.knownS = fi.ModTime().UnixMilli(), fi.Size()
	} else {
		st.knownM, st.knownS = 0, 0
	}
	st.stop = make(chan struct{})
	// events / 回调作为局部参数传入：StopWatch 会把 st.w 置 nil 并 Close，
	// 旧 goroutine 不得再解引用共享字段（否则下一轮读 st.w.Events 直接 panic）。
	events, errs, cb := w.Events, w.Errors, st.onChange
	go s.watcherLoop(st, st.stop, events, errs, cb)
}

// StopWatch 停止监视当前文件（关闭文件/退出时调用）。
func (s *Store) StopWatch() {
	st := &s.watcher
	st.mu.Lock()
	defer st.mu.Unlock()
	s.watcherStopLocked()
}

// watcherStopLocked 停掉现有循环与 watcher，调用方须已持有 st.mu。
func (s *Store) watcherStopLocked() {
	st := &s.watcher
	if st.stop != nil {
		close(st.stop)
		st.stop = nil
	}
	if st.w != nil {
		_ = st.w.Close()
		st.w = nil
	}
	st.watched = ""
}

// MarkSaved 在本应用写盘后调用，把抑制窗口设为当下。
func (s *Store) MarkSaved() {
	st := &s.watcher
	h := ""
	st.mu.Lock()
	path := st.watched
	st.mu.Unlock()
	if path != "" {
		h, _ = fileHash(path)
	}
	st.mu.Lock()
	st.savedAt = time.Now()
	st.savedHash = h
	if st.watched != "" {
		if fi, err := os.Stat(st.watched); err == nil {
			st.knownM, st.knownS = fi.ModTime().UnixMilli(), fi.Size()
		}
	}
	st.mu.Unlock()
}

// fileHash 计算文件内容哈希（用于区分自身写入与窗口内的外部修改）。
func fileHash(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// watcherLoop 事件循环：防抖合并事件，换算成 FileEvent 抛给回调。
// events / errs / cb 均由 WatchFile 在创建 watcher 时捕获为局部值。
func (s *Store) watcherLoop(st *watcherState, stop chan struct{}, events <-chan fsnotify.Event, errs <-chan error, cb func(FileEvent)) {
	var debounce *time.Timer
	fire := func() {
		ev := s.watcherCheck()
		if ev != nil && cb != nil {
			cb(*ev)
		}
	}
	debounce = time.NewTimer(time.Hour)
	debounce.Stop()
	defer debounce.Stop()

	for {
		select {
		case <-stop:
			return
		case <-errs: // 必须排空 fsnotify 错误通道，否则内部可能阻塞
		case ev, ok := <-events:
			if !ok {
				return
			}
			// 仅关心目标文件；写临时文件（.mdview-*.tmp）等目录噪音全部忽略
			if filepath.Clean(ev.Name) != st.watched && filepath.Base(ev.Name) != filepath.Base(st.watched) {
				continue
			}
			if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
				// 临时文件替换写法：rename 后立刻重建同路径文件，稍等一次再判定去留
				debounce.Reset(watchDebounce)
				continue
			}
			debounce.Reset(watchDebounce)
		case <-debounce.C:
			fire()
			debounce.Reset(time.Hour)
		}
	}
}

// watcherCheck 防抖触发后统一判定：自身保存抑制 / mtime+size 变化 / 是否已删除。
// 返回 nil 表示无需通知。
func (s *Store) watcherCheck() *FileEvent {
	st := &s.watcher
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.watched == "" {
		return nil
	}
	fi, err := os.Stat(st.watched)
	if err != nil {
		// 文件消失；若在自身保存抑制窗口内先不慌（原子写瞬间的 stat 空档）
		if time.Since(st.savedAt) < saveSuppressAfter {
			return nil
		}
		return &FileEvent{Kind: "gone", Path: st.watched}
	}
	m, sz := fi.ModTime().UnixMilli(), fi.Size()
	if m == st.knownM && sz == st.knownS {
		return nil
	}
	// 本应用自己刚保存的写入：只有内容哈希与保存时一致才吸收。
	// 纯时间窗口会吞掉这 2 秒内真正的外部修改（并把 knownM/S 更新成新值，之后永远不再报）。
	if time.Since(st.savedAt) < saveSuppressAfter {
		if h, err := fileHash(st.watched); err == nil && h == st.savedHash {
			st.knownM, st.knownS = m, sz
			return nil
		}
	}
	st.knownM, st.knownS = m, sz
	return &FileEvent{Kind: "changed", Path: st.watched, ModTime: m, Size: sz}
}
