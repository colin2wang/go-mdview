// Package storage unifies persistence: atomic read/write (temp+rename) of the
// settings / history / favorites JSON files, the external-modify watch facade,
// and the exe-adjacent mdview.yml config source.
package storage

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"

	"mdview/internal/fsops"
	"mdview/internal/settings"
	"mdview/internal/watcher"
)

// FileEvent aliases the watcher event type under the storage namespace.
type FileEvent = watcher.FileEvent

// Node and FileContent alias the fsops tree and file types.
type (
	Node        = fsops.Node
	FileContent = fsops.FileContent
)

// Store manages the settings / history / favorites JSON files under
// os.UserConfigDir()/mdview/, written atomically (temp+rename).
type Store struct {
	mu      sync.Mutex
	once    sync.Once
	baseDir string
	// External file modification watching; value semantics so a zero Store works.
	watcher watcher.Watcher

	// Last persistence error, surfaced to the frontend after each save.
	errMu   sync.Mutex
	lastErr string
}

// LastError returns and clears the last persistence error.
func (s *Store) LastError() string {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	v := s.lastErr
	s.lastErr = ""
	return v
}

func (s *Store) setError(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	s.lastErr = err.Error()
	s.errMu.Unlock()
	log.Printf("mdview: %v", err)
}

func NewStore() *Store {
	return &Store{}
}

// SetFileChangeCallback registers the external-modify event callback.
func (s *Store) SetFileChangeCallback(cb func(FileEvent)) { s.watcher.SetFileChangeCallback(cb) }

// WatchFile watches a path for external modification; switching files replaces the target.
func (s *Store) WatchFile(path string) { s.watcher.WatchFile(path) }

// StopWatch stops watching the current file.
func (s *Store) StopWatch() { s.watcher.Stop() }

// MarkSaved suppresses the next identical-content event after an app save.
func (s *Store) MarkSaved() { s.watcher.MarkSaved() }

// Tree / wiki index / encoding-aware IO, forwarded to internal/fsops.

// InvalidateTreeCache forces the next ListTree to rescan the disk.
func InvalidateTreeCache() { fsops.InvalidateTreeCache() }

// ListTree scans directories and markdown files under root.
func (s *Store) ListTree(root string) ([]Node, error) { return fsops.ListTree(root) }

// FindByTitles returns all candidates for a same-name note.
func (s *Store) FindByTitles(root, title string) []string { return fsops.FindByTitles(root, title) }

// FindByTitle returns the first same-name match or an empty string.
func (s *Store) FindByTitle(root, title string) string { return fsops.FindByTitle(root, title) }

// ReadMarkdown reads a .md file with automatic encoding detection.
func (s *Store) ReadMarkdown(path string) (FileContent, error) { return fsops.ReadFile(path) }

// SaveMarkdown writes edited content back atomically, preserving encoding/BOM/CRLF.
func (s *Store) SaveMarkdown(path, content, encoding string) (FileContent, error) {
	return fsops.SaveFile(path, content, encoding)
}

// StatFile reports whether a file exists along with its modification time.
func (s *Store) StatFile(path string) (int64, bool) { return fsops.StatFile(path) }

// JSON persistence.

func (s *Store) base() string {
	// baseDir is resolved once: binding methods run concurrently, so a
	// check-then-write would race, and s.mu is not reentrant here because
	// writeJSON calls base() while holding it.
	s.once.Do(func() {
		if os.Getenv("MDVIEW_HOME") != "" {
			s.baseDir = os.Getenv("MDVIEW_HOME")
		} else {
			cfg, err := os.UserConfigDir()
			if err != nil {
				home, _ := os.UserHomeDir()
				s.baseDir = filepath.Join(home, ".mdview")
			} else {
				s.baseDir = filepath.Join(cfg, "mdview")
			}
		}
		_ = os.MkdirAll(s.baseDir, 0o755)
	})
	return s.baseDir
}

func (s *Store) readJSON(name string, v interface{}) error {
	path := filepath.Join(s.base(), name)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			s.setError(err)
		}
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		s.setError(err)
		return err
	}
	return nil
}

func (s *Store) writeJSON(name string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		s.setError(err)
		return err
	}
	target := filepath.Join(s.base(), name)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		s.setError(err)
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		s.setError(err)
		return err
	}
	return nil
}

// Settings persistence.

// GetSettings reads the settings with defaults filled in.
func (s *Store) GetSettings() settings.Settings {
	st := settings.DefaultSettings
	s.mu.Lock()
	s.readJSON("settings.json", &st)
	s.mu.Unlock()
	// An existing mdview.yml next to the exe acts as the config source;
	// keys present there override the JSON values.
	if yamlExists() && !yamlDisabled() {
		st.UseYaml = true
		loadYamlSettings(&st)
	} else if yamlDisabled() {
		st.UseYaml = false
	}
	settings.Normalize(&st)
	return st
}

// SaveSettings clamps and persists the settings.
func (s *Store) SaveSettings(in settings.Settings) settings.Settings {
	st := in
	settings.Clamp(&st)
	s.mu.Lock()
	if st.UseYaml {
		// YAML mode: write mdview.yml only; on failure fall back to JSON.
		if err := writeYamlSettings(st); err != nil {
			s.setError(err)
			s.writeJSON("settings.json", &st)
		}
	} else {
		// JSON mode: remove any local yml so it cannot re-enable itself.
		s.writeJSON("settings.json", &st)
		if err := removeYaml(); err != nil {
			s.setError(err)
		}
	}
	s.mu.Unlock()
	return st
}
