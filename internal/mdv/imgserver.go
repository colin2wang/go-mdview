package mdv

import (
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ImgHandler 本地图片回放路由：/mdimg/{hex(绝对路径)}/{文件名}
// 整段路径 hex 编码后作为单一 segment，天然规避路径穿越。
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
	// Windows 盘符路径里的反斜杠已被原样编码；Separator 归一交给 OS
	ct := contentTypeByExt(p)
	if ct == "" {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	data, err := os.ReadFile(p)
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		http.NotFound(w, r)
		return
	}
	// SVG 以图片上下文提供（<img> 内脚本不执行）；显式声明类型防嗅探
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "max-age=86400")
	w.Header().Set("Content-Length", itoa(len(data)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(data)
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

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
