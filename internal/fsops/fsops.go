// Package fsops 提供目录树扫描、同名标题索引与 markdown 文件编码读写。
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

// previewable 是否可预览：markdown / 图片 / 文本
func previewable(ext string) bool {
	return mdExts[ext] || imgExts[ext] || textExts[ext]
}

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

// naturalLess 人类直觉排序：数字段按数值比（02 < 10），字母不区分大小写。
func naturalLess(a, b string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	i, j := 0, 0
	for i < len(a) && len(b) > j {
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

// maxTreeNodes 单棵目录树的最大节点数，防止超大 vault 一次性递归把 UI 卡死。
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

// InvalidateTreeCache 在显式刷新/保存后调用，让下一次 ListTree 重新扫描磁盘。
func InvalidateTreeCache() {
	treeCacheMu.Lock()
	treeCache = map[string]treeCacheEntry{}
	treeCacheMu.Unlock()
}

// ListTree 扫描 root 下的目录与 markdown 文件（跳过隐藏/垃圾目录）。
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
	// 打开目录树即登记根目录：/mdimg 回放允许该目录子树内的图片
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
					continue // 空目录不进树
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

// ---------- 同名标题索引 ----------

// titleIndex 是「目录根 → 文件名（小写，不带扩展名）→ 绝对路径列表」的一次性索引，
// 避免每次点 wiki 链接都全目录递归。TTL 到期或显式失效后重建。
type titleIndexEntry struct {
	at  time.Time
	idx map[string][]string
}

var (
	titleIndexMu    sync.Mutex
	titleIndexCache = map[string]titleIndexEntry{}
)

const titleIndexTTL = 10 * time.Second

// InvalidateTitleIndex 在保存/目录树变化后调用，让下一次 wiki 查找重建索引。
func InvalidateTitleIndex() {
	titleIndexMu.Lock()
	titleIndexCache = map[string]titleIndexEntry{}
	titleIndexMu.Unlock()
}

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

// FindByTitles 返回同名笔记的全部候选（用于同名消歧）；结果按路径排序保持稳定。
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

// FindByTitle 兼容旧调用：返回第一个匹配，找不到返回空串。
func FindByTitle(root, title string) string {
	if hits := FindByTitles(root, title); len(hits) > 0 {
		return hits[0]
	}
	return ""
}
