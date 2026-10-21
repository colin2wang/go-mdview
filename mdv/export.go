package mdv

import (
	"os"
	"path/filepath"
	"strings"
	"time"
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

// ExportHtml 将前端渲染好的 HTML 片段包装为独立单文件写到 target。
func ExportHtml(title, html, target string) (string, error) {
	target = strings.TrimSpace(target)
	if target == "" {
		target = "mdview-export-" + time.Now().Format("20060102-150405") + ".html"
	}
	if filepath.Ext(target) == "" {
		target += ".html"
	}
	var b strings.Builder
	b.WriteString(exportHead)
	b.WriteString(strings.ReplaceAll(title, "<", "&lt;"))
	b.WriteString(exportMid)
	b.WriteString(html)
	b.WriteString("\n</body>\n</html>\n")
	if err := os.WriteFile(target, []byte(b.String()), 0o644); err != nil {
		return "", err
	}
	return target, nil
}
