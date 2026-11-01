package mdv

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
var (
	imgRootsMu sync.Mutex
	imgRoots   []string
)

// maxImgRoots 白名单上限，超过时淘汰最早登记的目录，避免无限增长。
const maxImgRoots = 32

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
	imgRootsMu.Lock()
	defer imgRootsMu.Unlock()
	for _, r := range imgRoots {
		if strings.EqualFold(r, dir) {
			return
		}
	}
	if len(imgRoots) >= maxImgRoots {
		imgRoots = imgRoots[1:]
	}
	imgRoots = append(imgRoots, dir)
}

// imgPathAllowed 判断 p 是否落在任一已登记目录子树内。
// Windows 路径大小写不敏感，统一按不区分大小写比较。
func imgPathAllowed(p string) bool {
	dir := filepath.Clean(filepath.Dir(p))
	imgRootsMu.Lock()
	defer imgRootsMu.Unlock()
	for _, root := range imgRoots {
		if strings.EqualFold(dir, root) {
			return true
		}
		if len(dir) > len(root) && strings.HasPrefix(strings.ToLower(dir), strings.ToLower(root)+string(filepath.Separator)) {
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
	ct := contentTypeByExt(p)
	if ct == "" {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	if !imgPathAllowed(p) {
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
	w.Header().Set("Cache-Control", "max-age=86400")
	// SVG 以图片上下文提供（<img> 内脚本不执行）；显式声明类型防嗅探
	http.ServeContent(w, r, path.Base(p), fi.ModTime().Round(time.Second), f)
})

func contentTypeByExt(p string) string {
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
