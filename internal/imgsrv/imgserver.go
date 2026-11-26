package imgsrv

import (
	"encoding/hex"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// 允许通过 /mdimg 回放的目录白名单。
// hex 编码只规避路径穿越，不限制范围——恶意 md 里的 <img> 可以指向任意
// 本地文件（如 ~/.ssh、settings.json）把内容当图片读出来。打开文件/目录
// 时登记目录，回放时校验目标必须落在某个已登记目录的子树内，越界 403。
type imgRoot struct {
	dir  string // Clean 后的登记路径
	real string // EvalSymlinks 后的真实路径（失败时等于 dir）
	used int64  // 最近一次命中时间，用于 LRU 淘汰
}

var (
	imgRootsMu sync.Mutex
	imgRoots   []imgRoot
)

// maxImgRoots 白名单上限：LRU 淘汰（不是 FIFO），避免早先打开的目录突然整片 403。
const maxImgRoots = 128

// AllowImageDir 登记一个允许回放图片的目录（含其子树）。
func AllowImageDir(dir string) {
	if dir == "" {
		return
	}
	dir = filepath.Clean(dir)
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		return
	}
	real := realPath(dir)
	imgRootsMu.Lock()
	defer imgRootsMu.Unlock()
	now := time.Now().UnixNano()
	for i, r := range imgRoots {
		if strings.EqualFold(r.dir, dir) || strings.EqualFold(r.real, real) {
			imgRoots[i].used = now
			return
		}
	}
	if len(imgRoots) >= maxImgRoots {
		// 淘汰最久未使用的目录；刚加入的目录不参与本轮淘汰
		oldest := 0
		for i := 1; i < len(imgRoots); i++ {
			if imgRoots[i].used < imgRoots[oldest].used {
				oldest = i
			}
		}
		imgRoots = append(imgRoots[:oldest], imgRoots[oldest+1:]...)
	}
	imgRoots = append(imgRoots, imgRoot{dir: dir, real: real, used: now})
}

// realPath 尽量解析符号链接/联结点，拿不到就退回原路径（文件可能刚被删除）。
func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return filepath.Clean(r)
	}
	return filepath.Clean(p)
}

// PathAllowed 判断 p 是否落在任一已登记目录子树内。
// 同时比较登记路径与真实路径，防止符号链接把白名单内目录指到外面去。
// Windows 路径大小写不敏感，统一按不区分大小写比较。
func PathAllowed(p string) bool {
	p = filepath.Clean(p)
	dir := filepath.Clean(filepath.Dir(p))
	real := realPath(p)
	realDir := filepath.Clean(filepath.Dir(real))

	imgRootsMu.Lock()
	defer imgRootsMu.Unlock()
	now := time.Now().UnixNano()
	hit := func(candidate string, r imgRoot) bool {
		return strings.EqualFold(candidate, r.dir) ||
			strings.EqualFold(candidate, r.real) ||
			(len(candidate) > len(r.dir) && strings.HasPrefix(strings.ToLower(candidate), strings.ToLower(r.dir)+string(filepath.Separator))) ||
			(len(candidate) > len(r.real) && strings.HasPrefix(strings.ToLower(candidate), strings.ToLower(r.real)+string(filepath.Separator)))
	}
	for i, root := range imgRoots {
		if hit(dir, root) && hit(realDir, root) {
			imgRoots[i].used = now
			return true
		}
	}
	return false
}

// ImgHandler 本地图片回放路由：/mdimg/{hex(绝对路径)}/{文件名}
// 整段路径 hex 编码后作为单一 segment，天然规避路径穿越；
// 目标路径必须在已登记目录子树内（见 AllowImageDir），否则 403。
var ImgHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/mdimg/")
	if rest == "" {
		http.NotFound(w, r)
		return
	}
	hexPart := rest
	if i := strings.IndexByte(rest, '/'); i >= 0 {
		hexPart = rest[:i]
	}
	raw, err := hex.DecodeString(hexPart)
	if err != nil {
		http.Error(w, "bad path encoding", http.StatusBadRequest)
		return
	}
	p := strings.TrimSpace(string(raw))
	if !filepath.IsAbs(p) && !(len(p) >= 3 && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) {
		http.Error(w, "absolute path required", http.StatusBadRequest)
		return
	}
	ct := ContentTypeByExt(p)
	if ct == "" {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	if !PathAllowed(p) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsPermission(err) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil || fi.IsDir() {
		http.NotFound(w, r)
		return
	}
	// ServeContent 自带 Range / 条件请求 / Last-Modified / Content-Length
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// 本地图片改动后应尽快反映出来；短缓存 + 条件请求（ServeContent 自带 ETag/Last-Modified）
	w.Header().Set("Cache-Control", "max-age=5, must-revalidate")
	// SVG 以图片上下文提供（<img> 内脚本不执行）；显式声明类型防嗅探
	http.ServeContent(w, r, path.Base(p), fi.ModTime().Round(time.Second), f)
})

// ContentTypeByExt 按扩展名返回图片 Content-Type，非图片扩展名返回空。
func ContentTypeByExt(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	case ".svg":
		return "image/svg+xml"
	case ".avif":
		return "image/avif"
	default:
		return ""
	}
}
