package mdv

import (
	"encoding/hex"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	t.Setenv("MDVIEW_HOME", t.TempDir())
	return NewStore()
}

func TestSettingsDefaultsAndClamp(t *testing.T) {
	s := newTestStore(t)
	st := s.GetSettings()
	if st.Theme != "light" || st.FontSize != 16 || st.SidebarWidth != 280 {
		t.Fatalf("默认值不符: %+v", st)
	}
	if st.ViewMode != ViewModeRender {
		t.Fatalf("默认视图模式不符: %q", st.ViewMode)
	}
	st.Theme = "night"
	st.FontSize = 99
	st.SidebarWidth = 10
	st.ViewMode = "bogus"
	got := s.SaveSettings(st)
	if got.Theme != "light" || got.FontSize != 28 || got.SidebarWidth != 200 {
		t.Fatalf("clamp 失败: %+v", got)
	}
	if got.ViewMode != ViewModeRender {
		t.Fatalf("非法视图模式未回落: %q", got.ViewMode)
	}
	if s.GetSettings().ViewMode != ViewModeRender {
		t.Fatal("视图模式未落盘")
	}
	if s.GetSettings().FontSize != 28 {
		t.Fatal("设置未落盘")
	}
}

func TestHistoryDedupeAndLimit(t *testing.T) {
	s := newTestStore(t)
	dir := t.TempDir()
	a := filepath.Join(dir, "a.md")
	b := filepath.Join(dir, "b.md")
	_ = os.WriteFile(a, []byte("a"), 0o644)
	_ = os.WriteFile(b, []byte("b"), 0o644)
	s.PushHistory(a)
	s.PushHistory(b)
	s.PushHistory(a) // 置顶去重
	h := s.GetHistory()
	if len(h) != 2 || h[0].Path != a {
		t.Fatalf("去重置顶失败: %+v", h)
	}
	// 上限
	for i := 0; i < historyLimit+20; i++ {
		s.PushHistory(filepath.Join(dir, fmt.Sprintf("f%03d.md", i))) // 唯一路径
	}
	if len(s.GetHistory()) != historyLimit {
		t.Fatalf("截断失败: %d", len(s.GetHistory()))
	}
	if len(s.ClearHistory()) != 0 {
		t.Fatal("清空失败")
	}
}

func TestFavoritesToggle(t *testing.T) {
	s := newTestStore(t)
	f := filepath.Join(t.TempDir(), "n.md")
	_ = os.WriteFile(f, []byte("x"), 0o644)
	fav, _ := s.ToggleFavorite(f)
	if !fav || !s.IsFavorite(f) {
		t.Fatal("收藏失败")
	}
	fav2, list := s.ToggleFavorite(f)
	if fav2 || len(list) != 0 || s.IsFavorite(f) {
		t.Fatal("取消收藏失败")
	}
}

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
		j(root, "01-基础", "b.txt"),         // 非 md 也进树，仅标记不可预览
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
	s := newTestStore(t)
	root := writeTree(t)
	tree, err := s.ListTree(root)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(nodesFlat(tree), ",")
	// 排序：目录在前（01-基础 < 子 < 已存档，数字段按值），文件按数值（02 < 10 < README）；非 md 文件同样进树
	wantOrder := []string{"01-基础", "a.md", "b.txt", "子", "深", "deep.md", "已存档", "old.md", "02-语法.md", "10-进阶.md", "README.MD"}
	if got != strings.Join(wantOrder, ",") {
		t.Fatalf("树/排序不符:\n got=%s\nwant=%s", got, strings.Join(wantOrder, ","))
	}
	// 支持标记：md 文件可预览，b.txt 不可，目录恒可
	for _, n := range tree {
		if n.Name == "01-基础" {
			for _, c := range n.Children {
				if c.Name == "a.md" && !c.Supported {
					t.Fatal("a.md 应标记为可预览")
				}
				if c.Name == "b.txt" && c.Supported {
					t.Fatal("b.txt 不应标记为可预览")
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
		{"B.md", "a.md", true}, // 大小写不敏感：b < a? 不，b>a → false
	}
	cases[3] = struct {
		a, b string
		want bool
	}{"B.md", "a.md", false}
	for _, c := range cases {
		if got := naturalLess(c.a, c.b); got != c.want {
			t.Fatalf("naturalLess(%q,%q)=%v want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestReadMarkdownEncodings(t *testing.T) {
	s := newTestStore(t)
	dir := t.TempDir()
	// UTF-8
	u := filepath.Join(dir, "u.md")
	_ = os.WriteFile(u, []byte("# 中文标题\n内容"), 0o644)
	uc, err := s.ReadMarkdown(u)
	if err != nil || uc.Encoding != "utf-8" || !strings.Contains(uc.Content, "中文标题") {
		t.Fatalf("utf-8 读取失败: %+v err=%v", uc, err)
	}
	// GBK 字节
	g := filepath.Join(dir, "g.md")
	gbk := []byte{0xB1, 0xBE, 0xB5, 0xD8, 0xB2, 0xE2, 0xCA, 0xD4} // "本地测试"
	_ = os.WriteFile(g, gbk, 0o644)
	gc, err := s.ReadMarkdown(g)
	if err != nil || gc.Encoding != "gb18030" || !strings.Contains(gc.Content, "本地测试") {
		t.Fatalf("gb18030 转码失败: %+v err=%v", gc, err)
	}
	// BOM 剥离
	b := filepath.Join(dir, "b.md")
	_ = os.WriteFile(b, append([]byte{0xEF, 0xBB, 0xBF}, []byte("# x")...), 0o644)
	bc, _ := s.ReadMarkdown(b)
	if strings.HasPrefix(bc.Content, "\uFEFF") {
		t.Fatal("BOM 未剥离")
	}
	// 目录拒绝
	if _, err := s.ReadMarkdown(dir); err == nil {
		t.Fatal("目录应拒绝")
	}
}

func TestImgHandler(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "pic.png")
	_ = os.WriteFile(img, []byte{0x89, 'P', 'N', 'G'}, 0o644)
	hexp := hex.EncodeToString([]byte(img))
	// 正常读取
	req := httptest.NewRequest("GET", "/mdimg/"+hexp+"/pic.png", nil)
	w := httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 200 || w.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("图片回放失败: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
	body, _ := io.ReadAll(w.Body)
	if len(body) != 4 {
		t.Fatal("内容不匹配")
	}
	// 非图片扩展名拒绝
	txt := filepath.Join(dir, "evil.svg.txt")
	_ = os.WriteFile(txt, []byte("x"), 0o644)
	req = httptest.NewRequest("GET", "/mdimg/"+hex.EncodeToString([]byte(txt)), nil)
	w = httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 415 {
		t.Fatalf("非图片应 415: %d", w.Code)
	}
	// 相对路径拒绝
	req = httptest.NewRequest("GET", "/mdimg/"+hex.EncodeToString([]byte("etc/passwd")), nil)
	w = httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("相对路径应 400: %d", w.Code)
	}
	// 坏 hex（用合法 URL 字符，httptest 不允许 %zz）
	req = httptest.NewRequest("GET", "/mdimg/zz!@", nil)
	w = httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatalf("坏 hex 应 400: %d", w.Code)
	}
	// 不存在的文件
	req = httptest.NewRequest("GET", "/mdimg/"+hex.EncodeToString([]byte(filepath.Join(dir, "no.png"))), nil)
	w = httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("缺失文件应 404: %d", w.Code)
	}
}

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

func TestFindByTitle(t *testing.T) {
	s := newTestStore(t)
	root := writeTree(t)
	hit := s.FindByTitle(root, "deep")
	if hit == "" || filepath.Base(hit) != "deep.md" {
		t.Fatalf("wiki 解析失败: %q", hit)
	}
	if s.FindByTitle(root, "不存在") != "" {
		t.Fatal("应返回空")
	}
}
