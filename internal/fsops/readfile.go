package fsops

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/traditionalchinese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"

	"mdview/internal/imgsrv"
)

// FileContent is the result of reading a file.
type FileContent struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Dir      string `json:"dir"`
	Content  string `json:"content"`
	Encoding string `json:"encoding"` // utf-8 | gb18030
	Size     int64  `json:"size"`
	ModTime  int64  `json:"modTime"`
}

const maxReadSize = 32 << 20 // 32MB

// textInfo holds the detected encoding/newline facts, reused verbatim on save.
type textInfo struct {
	content  string
	encoding string
	newline  string
	bom      bool
}

// detectText detects the encoding by trying BOM, UTF-8, GB18030, Big5 and
// Shift-JIS in order; it also records the newline style and BOM presence.
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

// encodeText encodes content back to bytes using the detected encoding/BOM/newline.
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

// ReadFile reads a .md file with automatic encoding detection.
func ReadFile(path string) (FileContent, error) {
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
	imgsrv.AllowImageDir(filepath.Dir(path))
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

// SaveFile writes edited content back atomically (temp file + rename) and
// returns a fresh read of the file. The on-disk encoding/BOM/newline of the
// original file are preserved; a file deleted externally is recreated,
// including missing parent directories.
func SaveFile(path, content, encoding string) (FileContent, error) {
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
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return FileContent{}, err
	}
	_ = tmp.Chmod(perm)
	if err := tmp.Close(); err != nil {
		return FileContent{}, err
	}
	if err := os.Rename(tmpName, path); err != nil {
		if werr := os.WriteFile(path, data, perm); werr != nil {
			return FileContent{}, werr
		}
	}
	InvalidateTitleIndex()
	InvalidateTreeCache()
	return ReadFile(path)
}

type tooLargeError struct{}

// tooLargeError keeps a stable English message the frontend maps to localized text.
func (tooLargeError) Error() string { return "mdview: file too large (>32MB)" }

var errTooLarge error = tooLargeError{}

// StatFile reports whether a file exists along with its modification time.
func StatFile(path string) (int64, bool) {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return 0, false
	}
	return fi.ModTime().UnixMilli(), true
}
