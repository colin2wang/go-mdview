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

// imgRoot is one whitelisted directory whose images may be replayed via
// /mdimg. Hex encoding prevents path traversal but does not restrict scope:
// untrusted documents could otherwise point <img> at any local file. Targets
// must fall inside a registered directory subtree, else they are rejected.
type imgRoot struct {
	dir  string // registered path (Clean'ed)
	real string // EvalSymlinks'ed real path (equal to dir on failure)
	used int64  // last hit time, for LRU eviction
}

var (
	imgRootsMu sync.Mutex
	imgRoots   []imgRoot
)

// maxImgRoots caps the whitelist, evicted by LRU so old directories do not
// suddenly start failing.
const maxImgRoots = 128

// AllowImageDir registers a directory (and its subtree) for image replay.
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

// realPath resolves symlinks/junctions when possible, falling back to the
// given path (the file may have just been deleted).
func realPath(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return filepath.Clean(r)
	}
	return filepath.Clean(p)
}

// PathAllowed reports whether p falls inside any registered directory subtree.
// Both the registered and the real path are compared to stop symlinks from
// pointing outside the whitelist; comparisons are case-insensitive on Windows.
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

// ImgHandler is the local image replay route: /mdimg/{hex(abs path)}/{name}.
// The whole path is hex-encoded as a single segment, preventing traversal;
// the target must be inside a registered directory subtree (see AllowImageDir).
// It is mounted on the Wails asset server by main.go and listens on no port.
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
	// ServeContent provides Range / conditional requests / Last-Modified.
	w.Header().Set("Content-Type", ct)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Short cache plus revalidation so local edits show up quickly.
	w.Header().Set("Cache-Control", "max-age=5, must-revalidate")
	// SVG is served in image context (<img> never runs scripts).
	http.ServeContent(w, r, path.Base(p), fi.ModTime().Round(time.Second), f)
})

// ContentTypeByExt returns the image Content-Type for an extension, or "".
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
