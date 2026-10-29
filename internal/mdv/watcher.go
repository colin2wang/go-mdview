package mdv

import (
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
	mu       sync.Mutex
	w        *fsnotify.Watcher
	watched  string        // 当前监视的文件路径（Clean 后）
	knownM   int64         // 打开/上次刷新时的 mtime
	knownS   int64         // 打开/上次刷新时的 size
	savedAt  time.Time     // 本应用最后一次保存时间，用于抑制自身写入事件
	stop     chan struct{} // 事件循环退出信号
	onChange func(FileEvent)
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
	go s.watcherLoop(st, st.stop)
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
	st.mu.Lock()
	st.savedAt = time.Now()
	if st.watched != "" {
		if fi, err := os.Stat(st.watched); err == nil {
			st.knownM, st.knownS = fi.ModTime().UnixMilli(), fi.Size()
		}
	}
	st.mu.Unlock()
}

// watcherLoop 事件循环：防抖合并事件，换算成 FileEvent 抛给回调。
func (s *Store) watcherLoop(st *watcherState, stop chan struct{}) {
	var debounce *time.Timer
	fire := func() {
		ev := s.watcherCheck()
		if ev != nil && st.onChange != nil {
			st.onChange(*ev)
		}
	}
	debounce = time.NewTimer(time.Hour)
	debounce.Stop()
	defer debounce.Stop()

	for {
		select {
		case <-stop:
			return
		case ev, ok := <-st.w.Events:
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
	// 本应用自己刚保存的写入：吸收掉，并刷新已知状态
	if time.Since(st.savedAt) < saveSuppressAfter {
		st.knownM, st.knownS = m, sz
		return nil
	}
	st.knownM, st.knownS = m, sz
	return &FileEvent{Kind: "changed", Path: st.watched, ModTime: m, Size: sz}
}
