package mdv

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// FileContent 读取结果。
type FileContent struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // utf-8 | gb18030
	Size     int64  `json:"size"`
	ModTime  int64  `json:"modTime"`
}

const maxReadSize = 32 << 20 // 32MB 上限，防呆

// textInfo 是检测出的文本编码/换行风格信息，保存时据此原样回写。
type textInfo struct {
	content  string
	encoding string
	newline  string
	bom      bool
}

// detectText 依次尝试 BOM、UTF-8、GB18030、Big5、Shift-JIS；同时记录换行风格与 BOM。
func detectText(raw []byte) textInfo {
	info := textInfo{newline: "\n"}
	if bytes.Contains(raw, []byte("\r\n")) {
		info.newline = "\r\n"
	}
	decode := func(d transform.Transformer, enc string, skip int) (textInfo, bool) {
		b, err := io.ReadAll(transform.NewReader(bytes.NewReader(raw[skip:]), d))
		if err != nil || !utf8.Valid(b) {
			return textInfo{}, false
		}
		return textInfo{content: string(b), encoding: enc, newline: info.newline, bom: skip > 0}, true
	}
	if bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) {
		if v, ok := decode(transform.Nop, "utf-8", 3); ok {
			return v
		}
	}
	if bytes.HasPrefix(raw, []byte{0xFF, 0xFE}) {
		if v, ok := decode(unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder(), "utf-16le", 2); ok {
			return v
		}
	}
	if bytes.HasPrefix(raw, []byte{0xFE, 0xFF}) {
		if v, ok := decode(unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder(), "utf-16be", 2); ok {
			return v
		}
	}
	if utf8.Valid(raw) {
		return textInfo{content: string(raw), encoding: "utf-8", newline: info.newline}
	}
	for _, c := range []struct {
		name string
		dec  transform.Transformer
	}{
		{"gb18030", simplifiedchinese.GB18030.NewDecoder()},
		{"big5", traditionalchinese.Big5.NewDecoder()},
		{"shift_jis", japanese.ShiftJIS.NewDecoder()},
	} {
		if v, ok := decode(c.dec, c.name, 0); ok {
			return v
		}
	}
	return textInfo{
		content:  strings.ToValidUTF8(string(raw), string(utf8.RuneError)),
		encoding: "utf-8", newline: info.newline,
	}
}

// encodeText 按检测的编码/BOM/换行风格把正文编码回字节。
func encodeText(content, encoding, newline string, bom bool) []byte {
	if newline == "\r\n" {
		content = strings.ReplaceAll(content, "\r\n", "\n")
		content = strings.ReplaceAll(content, "\n", "\r\n")
	}
	var enc transform.Transformer
	switch strings.ToLower(encoding) {
	case "gb18030":
		enc = simplifiedchinese.GB18030.NewEncoder()
	case "big5":
		enc = traditionalchinese.Big5.NewEncoder()
	case "shift_jis":
		enc = japanese.ShiftJIS.NewEncoder()
	case "utf-16le":
		enc = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewEncoder()
	case "utf-16be":
		enc = unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewEncoder()
	default:
		encoding = "utf-8"
	}
	var data []byte
	if enc != nil {
		data, _ = io.ReadAll(transform.NewReader(strings.NewReader(content), enc))
	} else {
		data = []byte(content)
	}
	if bom {
		switch strings.ToLower(encoding) {
		case "utf-8":
			data = append([]byte{0xEF, 0xBB, 0xBF}, data...)
		case "utf-16le":
			data = append([]byte{0xFF, 0xFE}, data...)
		case "utf-16be":
			data = append([]byte{0xFE, 0xFF}, data...)
		}
	}
	return data
}

// ReadMarkdown 读取 .md 文本：BOM / UTF-8 / GB18030 / Big5 / Shift-JIS 自动探测。
func (s *Store) ReadMarkdown(path string) (FileContent, error) {
	path = filepath.Clean(path)
	fi, err := os.Stat(path)
	if err != nil {
		return FileContent{}, err
	}
	if fi.IsDir() {
		return FileContent{}, os.ErrInvalid
	}
	if fi.Size() > maxReadSize {
		return FileContent{}, errTooLarge
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return FileContent{}, err
	}
	// 打开成功即登记所在目录：/mdimg 回放仅允许已打开目录子树内的图片
	AllowImageDir(filepath.Dir(path))
	info := detectText(raw)
	return FileContent{
		Path:     path,
		Name:     filepath.Base(path),
		Dir:      filepath.Dir(path),
		Content:  info.content,
		Encoding: info.encoding,
		Size:     fi.Size(),
		ModTime:  fi.ModTime().UnixMilli(),
	}, nil
}

// SaveMarkdown 把编辑后的正文写回文件，返回刷新后的读取结果。
// encoding 为 gb18030 时按原编码回写，避免改动老笔记的编码；其余按 UTF-8。
// 采用「临时文件 + 重命名」的原子写法，避免写一半失败损坏原文。
// 文件已被外部删除（用户选择「保留」后）时保存会重建文件，含缺失的父目录。
func (s *Store) SaveMarkdown(path, content, encoding string) (FileContent, error) {
	path = filepath.Clean(path)
	fi, err := os.Stat(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return FileContent{}, err
		}
		if merr := os.MkdirAll(filepath.Dir(path), 0o755); merr != nil {
			return FileContent{}, merr
		}
		fi = nil
	} else if fi.IsDir() {
		return FileContent{}, os.ErrInvalid
	}

	perm := os.FileMode(0o644)
	if fi != nil {
		perm = fi.Mode().Perm()
	}

	// 以磁盘原文件的编码 / BOM / 换行风格为准（文件被外部删除时退回前端传来的 encoding）。
	enc, newline, bom := encoding, "\n", false
	if fi != nil {
		if raw, err := os.ReadFile(path); err == nil {
			info := detectText(raw)
			enc, newline, bom = info.encoding, info.newline, info.bom
		}
	}
	data := encodeText(content, enc, newline, bom)

	tmp, err := os.CreateTemp(filepath.Dir(path), ".mdview-*.tmp")
	if err != nil {
		return FileContent{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // 成功后已被 rename 移走，这里删除失败也无妨
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return FileContent{}, err
	}
	_ = tmp.Chmod(perm)
	if err := tmp.Close(); err != nil {
		return FileContent{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		// 极少数文件系统/权限下 rename 会失败，退化为直接覆盖写；
		// 回退也失败时返回真正的写入错误 werr（而不是掩盖它的 rename 错误）
		if werr := os.WriteFile(path, data, perm); werr != nil {
			return FileContent{}, werr
		}
	}
	InvalidateTitleIndex()
	InvalidateTreeCache()
	return s.ReadMarkdown(path)
}

type tooLargeError struct{}

// 错误文案用稳定的英文标识，前端按它映射到当前语言（避免 Go 侧硬编码中文）。
func (tooLargeError) Error() string { return "mdview: file too large (>32MB)" }

var errTooLarge error = tooLargeError{}

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
func (s *Store) FindByTitles(root, title string) []string {
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
func (s *Store) FindByTitle(root, title string) string {
	if hits := s.FindByTitles(root, title); len(hits) > 0 {
		return hits[0]
	}
	return ""
}

// StatFile 给前端判断文件是否仍存在（顺手返回修改时间）。
func (s *Store) StatFile(path string) (int64, bool) {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return 0, false
	}
	return fi.ModTime().UnixMilli(), true
}
