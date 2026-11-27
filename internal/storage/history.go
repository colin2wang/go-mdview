package storage

import (
	"os"
	"path/filepath"
	"time"

	"mdview/internal/imgsrv"
)

// Entry is a history/favorites record.
type Entry struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Exists   bool   `json:"exists"`
	OpenedAt int64  `json:"openedAt"` // unix seconds; for favorites the added time
}

const historyLimit = 100

func entryOf(path string, at int64) Entry {
	return Entry{
		Path:     path,
		Name:     filepath.Base(path),
		Dir:      filepath.Dir(path),
		Exists:   fileExists(path),
		OpenedAt: at,
	}
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

// GetHistory returns the recent-open list, newest first.
func (s *Store) GetHistory() []Entry {
	var list []Entry
	s.mu.Lock()
	s.readJSON("history.json", &list)
	s.mu.Unlock()
	for i := range list {
		list[i].Name = filepath.Base(list[i].Path)
		list[i].Dir = filepath.Dir(list[i].Path)
		list[i].Exists = fileExists(list[i].Path)
	}
	return list
}

// PushHistory records an open: deduplicated to the top, truncated at the limit.
// The file's directory is also registered for /mdimg replay.
func (s *Store) PushHistory(path string) []Entry {
	path = filepath.Clean(path)
	imgsrv.AllowImageDir(filepath.Dir(path))
	var list []Entry
	s.mu.Lock()
	s.readJSON("history.json", &list)
	out := make([]Entry, 0, len(list)+1)
	out = append(out, entryOf(path, time.Now().Unix()))
	for _, e := range list {
		if filepath.Clean(e.Path) == path {
			continue
		}
		out = append(out, e)
	}
	if len(out) > historyLimit {
		out = out[:historyLimit]
	}
	s.writeJSON("history.json", &out)
	s.mu.Unlock()
	return out
}

// RemoveHistory removes a single entry from the history (the file stays).
func (s *Store) RemoveHistory(path string) {
	path = filepath.Clean(path)
	s.mu.Lock()
	defer s.mu.Unlock()
	var list []Entry
	s.readJSON("history.json", &list)
	out := make([]Entry, 0, len(list))
	for _, e := range list {
		if filepath.Clean(e.Path) != path {
			out = append(out, e)
		}
	}
	s.writeJSON("history.json", &out)
}

// ClearHistory empties the history.
func (s *Store) ClearHistory() []Entry {
	s.mu.Lock()
	s.writeJSON("history.json", &[]Entry{})
	s.mu.Unlock()
	return []Entry{}
}

// GetFavorites returns the favorites list, newest added first.
func (s *Store) GetFavorites() []Entry {
	var list []Entry
	s.mu.Lock()
	s.readJSON("favorites.json", &list)
	s.mu.Unlock()
	for i := range list {
		list[i].Name = filepath.Base(list[i].Path)
		list[i].Dir = filepath.Dir(list[i].Path)
		list[i].Exists = fileExists(list[i].Path)
	}
	return list
}

// ToggleFavorite adds or removes a favorite and returns the new state.
func (s *Store) ToggleFavorite(path string) (bool, []Entry) {
	path = filepath.Clean(path)
	var list []Entry
	s.mu.Lock()
	s.readJSON("favorites.json", &list)
	found := -1
	for i, e := range list {
		if filepath.Clean(e.Path) == path {
			found = i
			break
		}
	}
	nowFav := true
	if found >= 0 {
		list = append(list[:found], list[found+1:]...)
		nowFav = false
	} else {
		list = append([]Entry{entryOf(path, time.Now().Unix())}, list...)
	}
	s.writeJSON("favorites.json", &list)
	s.mu.Unlock()
	return nowFav, s.GetFavorites()
}

// IsFavorite reports whether a path is currently a favorite.
func (s *Store) IsFavorite(path string) bool {
	path = filepath.Clean(path)
	var list []Entry
	s.mu.Lock()
	s.readJSON("favorites.json", &list)
	s.mu.Unlock()
	for _, e := range list {
		if filepath.Clean(e.Path) == path {
			return true
		}
	}
	return false
}
