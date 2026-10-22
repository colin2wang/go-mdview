package mdv

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
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
func (s *Store) PushHistory(path string) []Entry {
	path = filepath.Clean(path)
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

// ---------- 目录树扫描 ----------

// Node 文件树节点：目录或文件（仅 Supported 的文件可预览打开）。
type Node struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsDir     bool   `json:"isDir"`
	Supported bool   `json:"supported"`
	Children  []Node `json:"children,omitempty"`
}

var skipDirs = map[string]bool{
	".git": true, ".obsidian": true, ".vscode": true, ".idea": true,
	".svn": true, ".hg": true, "node_modules": true, "dist": true,
	"build": true, "target": true, "__pycache__": true, ".trash": true,
	"$recycle.bin": true, "system volume information": true,
}

var mdExts = map[string]bool{".md": true, ".markdown": true, ".mdown": true, ".mkd": true}

// imgExts 可直接预览的图片扩展名
var imgExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".svg": true, ".bmp": true, ".avif": true,
}

// textExts 可按纯文本预览的扩展名（代码/配置/日志等）
var textExts = map[string]bool{
	".txt": true, ".log": true, ".csv": true, ".tsv": true,
	".json": true, ".xml": true, ".yaml": true, ".yml": true,
	".toml": true, ".ini": true, ".cfg": true, ".conf": true,
	".html": true, ".htm": true, ".css": true, ".scss": true, ".less": true,
	".js": true, ".mjs": true, ".ts": true, ".tsx": true, ".jsx": true,
	".vue": true, ".go": true, ".py": true, ".java": true,
	".c": true, ".h": true, ".cpp": true, ".hpp": true, ".cs": true, ".rs": true,
	".rb": true, ".php": true, ".sh": true, ".bat": true, ".ps1": true, ".sql": true,
}

// previewable 是否可预览：markdown / 图片 / 文本
func previewable(ext string) bool {
	return mdExts[ext] || imgExts[ext] || textExts[ext]
}

// naturalLess 人类直觉排序：数字段按数值比（02 < 10），字母不区分大小写。
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		ca, cb := a[i], b[j]
		if isDigit(ca) && isDigit(cb) {
			// 提取完整数字段比较
			ia, sa := scanNum(a, i)
			ib, sb := scanNum(b, j)
			if ia != ib {
				return ia < ib
			}
			// 数值相同（前导零差异），短的算小
			if sa != sb {
				return sa < sb
			}
			i, j = sa, sb
			continue
		}
		if ca != cb {
			return ca < cb
		}
		i++
		j++
	}
	return len(a)-i < len(b)-j
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// scanNum 从 s[start] 起扫描数字段，返回数值（饱和防溢出）与结束下标。
func scanNum(s string, start int) (int64, int) {
	v := int64(0)
	i := start
	for i < len(s) && isDigit(s[i]) {
		if v < 1<<62 {
			v = v*10 + int64(s[i]-'0')
		}
		i++
	}
	return v, i
}

func sortNodes(nodes []Node) {
	sort.Slice(nodes, func(x, y int) bool {
		if nodes[x].IsDir != nodes[y].IsDir {
			return nodes[x].IsDir // 目录优先
		}
		return naturalLess(nodes[x].Name, nodes[y].Name)
	})
	for _, n := range nodes {
		if n.IsDir {
			sortNodes(n.Children)
		}
	}
}

// ListTree 扫描 root 下的目录与 markdown 文件（跳过隐藏/垃圾目录）。
func (s *Store) ListTree(root string) ([]Node, error) {
	root = filepath.Clean(root)
	fi, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		root = filepath.Dir(root)
	}
	var walk func(dir string, depth int) []Node
	walk = func(dir string, depth int) []Node {
		if depth > 12 {
			return nil
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return nil
		}
		var nodes []Node
		for _, e := range ents {
			name := e.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			p := filepath.Join(dir, name)
			if e.IsDir() {
				if skipDirs[strings.ToLower(name)] {
					continue
				}
				children := walk(p, depth+1)
				if children == nil {
					continue // 空目录不进树
				}
				nodes = append(nodes, Node{Name: name, Path: p, IsDir: true, Supported: true, Children: children})
			} else {
				nodes = append(nodes, Node{Name: name, Path: p, Supported: previewable(strings.ToLower(filepath.Ext(name)))})
			}
		}
		sortNodes(nodes)
		return nodes
	}
	return walk(root, 0), nil
}
