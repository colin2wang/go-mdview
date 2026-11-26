package fsops

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/encoding/transform"
)

func writeTree(t *testing.T) string {
	root := t.TempDir()
	j := filepath.Join
	_ = os.MkdirAll(j(root, "01-基础"), 0o755)
	_ = os.MkdirAll(j(root, "已存档"), 0o755)
	_ = os.MkdirAll(j(root, ".obsidian"), 0o755)
	_ = os.MkdirAll(j(root, "node_modules"), 0o755)
	_ = os.MkdirAll(j(root, "空目录"), 0o755)
	_ = os.MkdirAll(j(root, "子", "深"), 0o755)
	files := []string{
		j(root, "10-进阶.md"),
		j(root, "02-语法.md"),
		j(root, "01-基础", "a.md"),
		j(root, "01-基础", "b.txt"),         // 文本文件可预览
		j(root, "01-基础", "c.zip"),         // 二进制不可预览
		j(root, "已存档", "old.md"),          // 存档目录保留为普通子目录
		j(root, ".obsidian", "config.md"), // 隐藏目录跳过
		j(root, "node_modules", "x.md"),   // 垃圾目录跳过
		j(root, "子", "深", "deep.md"),      // 深层
		j(root, "README.MD"),              // 大写扩展名
	}
	for _, f := range files {
		_ = os.WriteFile(f, []byte("# t"), 0o644)
	}
	return root
}

func nodesFlat(nodes []Node) []string {
	var out []string
	for _, n := range nodes {
		out = append(out, n.Name)
		if n.IsDir {
			out = append(out, nodesFlat(n.Children)...)
		}
	}
	return out
}

func TestListTree(t *testing.T) {
	root := writeTree(t)
	tree, err := ListTree(root)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(nodesFlat(tree), ",")
	// 排序：目录在前（01-基础 < 子 < 已存档，数字段按值），文件按数值（02 < 10 < README）；非 md 文件同样进树
	wantOrder := []string{"01-基础", "a.md", "b.txt", "c.zip", "子", "深", "deep.md", "已存档", "old.md", "02-语法.md", "10-进阶.md", "README.MD"}
	if got != strings.Join(wantOrder, ",") {
		t.Fatalf("树/排序不符:\n got=%s\nwant=%s", got, strings.Join(wantOrder, ","))
	}
	// 支持标记：md/图片/文本可预览，二进制不可，目录恒可
	supportedOf := map[string]bool{"a.md": true, "b.txt": true, "c.zip": false}
	for _, n := range tree {
		if n.Name == "01-基础" {
			for _, c := range n.Children {
				want, ok := supportedOf[c.Name]
				if ok && c.Supported != want {
					t.Fatalf("%s Supported=%v, want %v", c.Name, c.Supported, want)
				}
			}
		}
	}
}

func TestNaturalLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"02.md", "10.md", true},
		{"1-x.md", "1-y.md", true},
		{"a2", "a10", true},
		{"B.md", "a.md", false}, // 大小写不敏感：b > a
	}
	for _, c := range cases {
		if got := naturalLess(c.a, c.b); got != c.want {
			t.Fatalf("naturalLess(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestFindByTitle(t *testing.T) {
	root := writeTree(t)
	hit := FindByTitle(root, "deep")
	if hit == "" || filepath.Base(hit) != "deep.md" {
		t.Fatalf("wiki 解析失败: %q", hit)
	}
	if FindByTitle(root, "不存在") != "" {
		t.Fatal("不存在标题应返回空串")
	}
}

func TestReadFileEncodings(t *testing.T) {
	dir := t.TempDir()
	// UTF-8
	u := filepath.Join(dir, "u.md")
	_ = os.WriteFile(u, []byte("# 中文标题\n内容"), 0o644)
	uc, err := ReadFile(u)
	if err != nil || uc.Encoding != "utf-8" || !strings.Contains(uc.Content, "中文标题") {
		t.Fatalf("utf-8 读取失败: %+v err=%v", uc, err)
	}
	// GBK 字节
	g := filepath.Join(dir, "g.md")
	gbk := []byte{0xB1, 0xBE, 0xB5, 0xD8, 0xB2, 0xE2, 0xCA, 0xD4} // "本地测试"
	_ = os.WriteFile(g, gbk, 0o644)
	gc, err := ReadFile(g)
	if err != nil || gc.Encoding != "gb18030" || !strings.Contains(gc.Content, "本地测试") {
		t.Fatalf("gb18030 转码失败: %+v err=%v", gc, err)
	}
	// BOM 剥离
	b := filepath.Join(dir, "b.md")
	_ = os.WriteFile(b, append([]byte{0xEF, 0xBB, 0xBF}, []byte("# x")...), 0o644)
	bc, _ := ReadFile(b)
	if strings.HasPrefix(bc.Content, "\uFEFF") {
		t.Fatal("BOM 未剥离")
	}
	// 目录拒绝
	if _, err := ReadFile(dir); err == nil {
		t.Fatal("目录应拒绝")
	}
}

func TestSaveFilePreservesEncodingAndCRLF(t *testing.T) {
	p := filepath.Join(t.TempDir(), "gb.md")
	_ = os.WriteFile(p, encodeText("标题\r\n正文", "gb18030", "\r\n", false), 0o644)
	got, err := SaveFile(p, "新标题\r\n新正文", "utf-8")
	if err != nil {
		t.Fatal(err)
	}
	if got.Encoding != "gb18030" {
		t.Fatalf("编码未保留: %q", got.Encoding)
	}
	raw, _ := os.ReadFile(p)
	if !bytes.Contains(raw, []byte("\r\n")) {
		t.Fatalf("CRLF 未保留: %q", raw)
	}
	decoded, err := io.ReadAll(transform.NewReader(bytes.NewReader(raw), simplifiedchinese.GB18030.NewDecoder()))
	if err != nil || string(decoded) != "新标题\r\n新正文" {
		t.Fatalf("GB18030 回写失败: %q, %v", decoded, err)
	}
}

// TestOverSizeLimit 防呆常量与错误类型未被意外变更。
func TestOverSizeLimit(t *testing.T) {
	if maxReadSize != 32<<20 {
		t.Fatalf("maxReadSize 意外变更: %d", maxReadSize)
	}
	if errTooLarge.Error() == "" {
		t.Fatal("errTooLarge 文案为空")
	}
}
