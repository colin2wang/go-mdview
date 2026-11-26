package exporter

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExportHtml(t *testing.T) {
	out := filepath.Join(t.TempDir(), "exp") // 无扩展名应补 .html
	got, err := ExportHtml("标题<T", "<h1>hi</h1>", out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got, ".html") {
		t.Fatalf("扩展名未补: %s", got)
	}
	data, _ := os.ReadFile(got)
	s := string(data)
	if !strings.Contains(s, "<title>标题&lt;T</title>") || !strings.Contains(s, "<h1>hi</h1>") {
		t.Fatalf("内容不符: %s", s)
	}
	if strings.Count(s, "<title>") != 1 {
		t.Fatal("title 应只出现一次")
	}
}
