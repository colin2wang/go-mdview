// Package watcher watches files for external modification: fsnotify
// directory-level watching with debouncing, mtime/size/hash checks, and a
// save-suppression window that distinguishes app writes from real external edits.
package watcher

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

// FileEvent is an external file event: changed = content may have changed,
// gone = the file was deleted or renamed.
type FileEvent struct {
	Kind    string `json:"kind"` // changed | gone
	Path    string `json:"path"`
	ModTime int64  `json:"modTime"` // latest mtime for changed events (UnixMilli)
	Size    int64  `json:"size"`
}

// Debounce window and save-suppression window.
const (
	watchDebounce     = 400 * time.Millisecond
	saveSuppressAfter = 2 * time.Second
)

// Watcher is a single-file external-modify watcher, usable at zero value.
// Events are delivered to the callback set before WatchFile.
type Watcher struct {
	mu        sync.Mutex
	w         *fsnotify.Watcher
	watched   string        // current watched path (Clean'ed)
	knownM    int64         // known mtime at open/last refresh
	knownS    int64         // known size at open/last refresh
	savedAt   time.Time     // last save by this app
	savedHash string        // content hash at save time, for suppression matching
	stop      chan struct{} // event loop exit signal
	onChange  func(FileEvent)
}

// SetFileChangeCallback registers the event callback; call before WatchFile.
func (w *Watcher) SetFileChangeCallback(cb func(FileEvent)) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.onChange = cb
}

// WatchFile watches path for external modification; switching files replaces
// the watch target. The watch is rebuilt every time because editors commonly
// save via temp-file-plus-rename, which invalidates the target.
func (w *Watcher) WatchFile(path string) {
	path = filepath.Clean(path)
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.watched == path {
		if fi, err := os.Stat(path); err == nil {
			w.knownM, w.knownS = fi.ModTime().UnixMilli(), fi.Size()
		}
		return
	}
	w.stopLocked()

	nw, err := fsnotify.NewWatcher()
	if err != nil {
		return
	}
	// The parent directory is watched: a file handle goes stale once the file
	// is replaced wholesale, but the directory keeps reporting events.
	_ = nw.Add(filepath.Dir(path))
	w.w = nw
	w.watched = path
	if fi, err := os.Stat(path); err == nil {
		w.knownM, w.knownS = fi.ModTime().UnixMilli(), fi.Size()
	} else {
		w.knownM, w.knownS = 0, 0
	}
	w.stop = make(chan struct{})
	// The channels and callback are captured as locals: Stop nils w.w and the
	// old goroutine must not dereference the shared fields.
	events, errs, cb := nw.Events, nw.Errors, w.onChange
	go w.loop(w, w.stop, events, errs, cb)
}

// Stop stops watching the current file.
func (w *Watcher) Stop() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.stopLocked()
}

// stopLocked stops the loop and watcher; the caller must hold w.mu.
func (w *Watcher) stopLocked() {
	if w.stop != nil {
		close(w.stop)
		w.stop = nil
	}
	if w.w != nil {
		_ = w.w.Close()
		w.w = nil
	}
	w.watched = ""
}

// MarkSaved opens the save-suppression window; call after the app writes.
func (w *Watcher) MarkSaved() {
	h := ""
	w.mu.Lock()
	path := w.watched
	w.mu.Unlock()
	if path != "" {
		h, _ = fileHash(path)
	}
	w.mu.Lock()
	w.savedAt = time.Now()
	w.savedHash = h
	if w.watched != "" {
		if fi, err := os.Stat(w.watched); err == nil {
			w.knownM, w.knownS = fi.ModTime().UnixMilli(), fi.Size()
		}
	}
	w.mu.Unlock()
}

// fileHash computes the file's SHA-256 hash.
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

// loop debounces events and dispatches FileEvents to the callback. The
// channels and callback are locals captured when the watcher was created.
func (w *Watcher) loop(st *Watcher, stop chan struct{}, events <-chan fsnotify.Event, errs <-chan error, cb func(FileEvent)) {
	var debounce *time.Timer
	fire := func() {
		ev := w.check()
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
		case <-errs: // drain the error channel so fsnotify cannot block
		case ev, ok := <-events:
			if !ok {
				return
			}
			// Ignore directory noise such as temp-file writes.
			if filepath.Clean(ev.Name) != st.watched && filepath.Base(ev.Name) != filepath.Base(st.watched) {
				continue
			}
			if ev.Has(fsnotify.Remove) || ev.Has(fsnotify.Rename) {
				// A rename is often followed by the file being recreated; wait once.
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

// check classifies the debounced event: save suppression, mtime+size change,
// or deletion. It returns nil when nothing should be reported.
func (w *Watcher) check() *FileEvent {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.watched == "" {
		return nil
	}
	fi, err := os.Stat(w.watched)
	if err != nil {
		// The file is gone; tolerate the stat gap right after an atomic save.
		if time.Since(w.savedAt) < saveSuppressAfter {
			return nil
		}
		return &FileEvent{Kind: "gone", Path: w.watched}
	}
	m, sz := fi.ModTime().UnixMilli(), fi.Size()
	if m == w.knownM && sz == w.knownS {
		return nil
	}
	// A write by this app is absorbed only when the content hash matches the
	// saved one; a pure time window would swallow real external edits made
	// within it.
	if time.Since(w.savedAt) < saveSuppressAfter {
		if h, err := fileHash(w.watched); err == nil && h == w.savedHash {
			w.knownM, w.knownS = m, sz
			return nil
		}
	}
	w.knownM, w.knownS = m, sz
	return &FileEvent{Kind: "changed", Path: w.watched, ModTime: m, Size: sz}
}
