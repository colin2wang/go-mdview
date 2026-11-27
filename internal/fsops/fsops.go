// Package fsops provides directory tree scanning, same-name title indexing,
// and encoding-aware reading/writing of markdown files.
package fsops

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"mdview/internal/imgsrv"
)

// Node is a file tree entry: a directory or a file (only previewable files can be opened).
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

// imgExts lists image extensions that can be previewed directly.
var imgExts = map[string]bool{
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true,
	".svg": true, ".bmp": true, ".avif": true,
}

// textExts lists extensions previewable as plain text (code/config/logs).
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

// previewable reports whether the extension can be previewed.
func previewable(ext string) bool {
	return mdExts[ext] || imgExts[ext] || textExts[ext]
}

// naturalLess compares strings the way humans sort them: digit runs by value
// (02 < 10), letters case-insensitively.
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(a) && len(b) > j {
		ca, cb := a[i], b[j]
		if isDigit(ca) && isDigit(cb) {
			ia, sa := scanNum(a, i)
			ib, sb := scanNum(b, j)
			if ia != ib {
				return ia < ib
			}
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

// scanNum scans the digit run starting at s[start] and returns its value
// (saturated to avoid overflow) and the end index.
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

// sortNodes sorts directories first, then names naturally, recursively.
func sortNodes(nodes []Node) {
	sort.Slice(nodes, func(x, y int) bool {
		if nodes[x].IsDir != nodes[y].IsDir {
			return nodes[x].IsDir
		}
		return naturalLess(nodes[x].Name, nodes[y].Name)
	})
	for _, n := range nodes {
		if n.IsDir {
			sortNodes(n.Children)
		}
	}
}

// maxTreeNodes caps a single tree scan so a huge vault cannot stall the UI.
const maxTreeNodes = 5000

type treeCacheEntry struct {
	at    time.Time
	nodes []Node
}

var (
	treeCacheMu  sync.Mutex
	treeCache    = map[string]treeCacheEntry{}
	treeCacheTTL = 2 * time.Second
)

// InvalidateTreeCache forces the next ListTree to rescan the disk.
func InvalidateTreeCache() {
	treeCacheMu.Lock()
	treeCache = map[string]treeCacheEntry{}
	treeCacheMu.Unlock()
}

// ListTree scans directories and markdown files under root, skipping
// hidden and junk directories.
func ListTree(root string) ([]Node, error) {
	root = filepath.Clean(root)
	treeCacheMu.Lock()
	if c, ok := treeCache[root]; ok && time.Since(c.at) < treeCacheTTL {
		nodes := c.nodes
		treeCacheMu.Unlock()
		return nodes, nil
	}
	treeCacheMu.Unlock()
	fi, err := os.Stat(root)
	if err != nil {
		return nil, err
	}
	if !fi.IsDir() {
		root = filepath.Dir(root)
	}
	imgsrv.AllowImageDir(root)
	remaining := maxTreeNodes
	var walk func(dir string, depth int) []Node
	walk = func(dir string, depth int) []Node {
		if depth > 12 || remaining <= 0 {
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
					continue
				}
				nodes = append(nodes, Node{Name: name, Path: p, IsDir: true, Supported: true, Children: children})
				remaining--
			} else {
				nodes = append(nodes, Node{Name: name, Path: p, Supported: previewable(strings.ToLower(filepath.Ext(name)))})
				remaining--
			}
			if remaining <= 0 {
				break
			}
		}
		sortNodes(nodes)
		return nodes
	}
	nodes := walk(root, 0)
	treeCacheMu.Lock()
	treeCache[root] = treeCacheEntry{at: time.Now(), nodes: nodes}
	treeCacheMu.Unlock()
	return nodes, nil
}

// titleIndexEntry caches "root → file name (lowercase, no extension) → paths"
// so wiki-link clicks do not rescan the whole tree.
type titleIndexEntry struct {
	at  time.Time
	idx map[string][]string
}

var (
	titleIndexMu    sync.Mutex
	titleIndexCache = map[string]titleIndexEntry{}
)

const titleIndexTTL = 10 * time.Second

// InvalidateTitleIndex forces the next wiki lookup to rebuild the index.
func InvalidateTitleIndex() {
	titleIndexMu.Lock()
	titleIndexCache = map[string]titleIndexEntry{}
	titleIndexMu.Unlock()
}

// buildTitleIndex walks the tree and collects lowercase markdown file names.
func buildTitleIndex(root string) map[string][]string {
	idx := map[string][]string{}
	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > 12 {
			return
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if !skipDirs[strings.ToLower(e.Name())] {
					walk(p, depth+1)
				}
				continue
			}
			if mdExts[strings.ToLower(filepath.Ext(e.Name()))] {
				base := strings.ToLower(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
				idx[base] = append(idx[base], p)
			}
		}
	}
	walk(root, 0)
	return idx
}

// FindByTitles returns all candidates for a same-name note, sorted by path
// for stable results.
func FindByTitles(root, title string) []string {
	root = filepath.Clean(root)
	titleIndexMu.Lock()
	entry, ok := titleIndexCache[root]
	if !ok || time.Since(entry.at) > titleIndexTTL {
		entry = titleIndexEntry{at: time.Now(), idx: buildTitleIndex(root)}
		titleIndexCache[root] = entry
	}
	hits := append([]string(nil), entry.idx[strings.ToLower(title)]...)
	titleIndexMu.Unlock()
	sort.Strings(hits)
	return hits
}

// FindByTitle returns the first match or an empty string.
func FindByTitle(root, title string) string {
	if hits := FindByTitles(root, title); len(hits) > 0 {
		return hits[0]
	}
	return ""
}
