package storage

import (
	"os"
	"path/filepath"
	"time"

	"mdview/internal/imgsrv"
)

// Entry 历史/收藏条目。
type Entry struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Exists   bool   `json:"exists"`
	OpenedAt int64  `json:"openedAt"` // unix 秒；收藏条目为加入时间
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

// GetHistory 最近打开记录，最新在前。
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

// PushHistory 记录一次打开：去重置顶，超限截断。
// 顺带登记所在目录：单独打开图片时也走这里，保证 /mdimg 能回放它。
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

// RemoveHistory 从历史里移除单条（不删除磁盘文件）。
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

// ClearHistory 清空历史。
func (s *Store) ClearHistory() []Entry {
	s.mu.Lock()
	s.writeJSON("history.json", &[]Entry{})
	s.mu.Unlock()
	return []Entry{}
}

// GetFavorites 收藏列表，最新加入在前。
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

// ToggleFavorite 收藏/取消收藏，返回切换后的状态。
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

// IsFavorite 查询某个路径是否已收藏。
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
