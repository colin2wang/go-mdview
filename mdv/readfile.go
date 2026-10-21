package mdv

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
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

// ReadMarkdown 读取 .md 文本：UTF-8 优先，非法则尝试 GB18030，剥离 BOM。
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
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF})
	enc := "utf-8"
	text := string(raw)
	if !utf8.Valid(raw) {
		if dec, err := simplifiedchinese.GB18030.NewDecoder().Bytes(raw); err == nil && utf8.Valid(dec) {
			text, enc = string(dec), "gb18030"
		} else {
			text = strings.ToValidUTF8(text, string(utf8.RuneError))
		}
	}
	return FileContent{
		Path:     path,
		Name:     filepath.Base(path),
		Dir:      filepath.Dir(path),
		Content:  text,
		Encoding: enc,
		Size:     fi.Size(),
		ModTime:  fi.ModTime().UnixMilli(),
	}, nil
}

type tooLargeError struct{}

func (tooLargeError) Error() string { return "文件过大（超过 32MB），mdview 不支持阅读" }

var errTooLarge error = tooLargeError{}

// FindByTitle 在树中按文件名（不带扩展名）查找，用于 [[wiki 链接]] 解析。
// 返回第一个匹配的 .md 绝对路径；找不到返回空串。
func (s *Store) FindByTitle(root, title string) string {
	var walk func(dir string, depth int) string
	walk = func(dir string, depth int) string {
		if depth > 12 {
			return ""
		}
		ents, err := os.ReadDir(dir)
		if err != nil {
			return ""
		}
		var subDirs []string
		for _, e := range ents {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			p := filepath.Join(dir, e.Name())
			if e.IsDir() {
				if !skipDirs[strings.ToLower(e.Name())] {
					subDirs = append(subDirs, p)
				}
				continue
			}
			if mdExts[strings.ToLower(filepath.Ext(e.Name()))] {
				base := strings.TrimSuffix(e.Name(), filepath.Ext(e.Name()))
				if strings.EqualFold(base, title) {
					return p
				}
			}
		}
		for _, d := range subDirs {
			if hit := walk(d, depth+1); hit != "" {
				return hit
			}
		}
		return ""
	}
	return walk(filepath.Clean(root), 0)
}

// StatFile 给前端判断文件是否仍存在（顺手返回修改时间）。
func (s *Store) StatFile(path string) (int64, bool) {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return 0, false
	}
	return fi.ModTime().UnixMilli(), true
}
