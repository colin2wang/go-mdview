package exporter

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"html"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mdview/internal/imgsrv"
)

const exportHead = "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n" +
	"<meta name=\"generator\" content=\"mdview\">\n<title>"

const exportMid = "</title>\n" +
	"<style>body{max-width:900px;margin:0 auto;padding:40px 20px;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;font-size:16px;line-height:1.6;color:#333;background:#fff}" +
	"pre{background:#f5f5f5;padding:16px 20px;border:1px solid #e0e0e0;border-radius:8px;overflow-x:auto}" +
	"code{background:#f0f0f0;padding:2px 6px;border-radius:4px;font-family:Consolas,monospace}pre code{background:transparent;padding:0}" +
	"table{border-collapse:separate;border-spacing:0;border:1px solid #ddd;border-radius:8px;width:100%;margin:12px 0}" +
	"th,td{border-top:1px solid #ddd;border-left:1px solid #ddd;padding:8px;text-align:left}" +
	"th{background:#f5f5f5}blockquote{border-left:4px solid #ddd;margin:0;padding-left:16px;color:#666}" +
	"a{color:#2563eb;text-decoration:none}img{max-width:100%}h1,h2{color:#333}hr{border:0;border-top:1px solid #c9ced4;margin:24px 0}" +
	"mark{background:#fde68a;padding:0 1px;border-radius:2px}</style>\n</head>\n<body>\n"

// mdimgSrcRe matches quoted src/href attributes; Go regexp has no
// backreferences, so double- and single-quoted forms are captured separately.
var mdimgSrcRe = regexp.MustCompile(`(?i)\b(src|href)=(?:"([^"]*)"|'([^']*)')`)

// embedExportImages replaces /mdimg references with data URIs so the exported
// file shows images without the app. Targets must still be inside a
// registered directory subtree; unreadable images are left untouched.
func embedExportImages(body string) string {
	return mdimgSrcRe.ReplaceAllStringFunc(body, func(m string) string {
		g := mdimgSrcRe.FindStringSubmatch(m)
		if len(g) < 4 {
			return m
		}
		quote, val := `"`, g[2]
		if g[2] == "" {
			quote, val = `'`, g[3]
		}
		if !strings.HasPrefix(strings.ToLower(val), "/mdimg/") {
			return m
		}
		hexPart := strings.SplitN(strings.TrimPrefix(val, "/mdimg/"), "/", 2)[0]
		raw, err := hex.DecodeString(hexPart)
		if err != nil {
			return m
		}
		p := strings.TrimSpace(string(raw))
		ct := imgsrv.ContentTypeByExt(p)
		if ct == "" || !imgsrv.PathAllowed(p) {
			return m
		}
		f, err := os.Open(p)
		if err != nil {
			return m
		}
		defer f.Close()
		data, err := io.ReadAll(f)
		if err != nil {
			return m
		}
		return fmt.Sprintf("%s=%sdata:%s;base64,%s%s", g[1], quote, ct, base64.StdEncoding.EncodeToString(data), quote)
	})
}

// ExportHtml wraps the rendered HTML fragment into a standalone single file.
// The parameter is named bodyHtml so it does not shadow the html package.
func ExportHtml(title, bodyHtml, target string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		target = "mdview-export-" + time.Now().Format("20060102-150405") + ".html"
	}
	if filepath.Ext(target) == "" {
		target += ".html"
	}
	var b strings.Builder
	b.WriteString(exportHead)
	b.WriteString(html.EscapeString(title))
	b.WriteString(exportMid)
	b.WriteString(embedExportImages(bodyHtml))
	b.WriteString("\n</body>\n</html>\n")
	if err := os.WriteFile(target, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return target, nil
}
