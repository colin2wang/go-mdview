package imgsrv

import (
	"encoding/hex"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestImgHandler(t *testing.T) {
	dir := t.TempDir()
	img := filepath.Join(dir, "pic.png")
	_ = os.WriteFile(img, []byte{0x89, 'P', 'N', 'G'}, 0o644)
	hexp := hex.EncodeToString([]byte(img))
	// 未登记目录：即使文件存在也应 403
	req := httptest.NewRequest("GET", "/mdimg/"+hexp+"/pic.png", nil)
	w := httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 403 {
		t.Fatalf("未登记目录应 403: %d", w.Code)
	}
	// 登记后正常读取
	AllowImageDir(dir)
	req = httptest.NewRequest("GET", "/mdimg/"+hexp+"/pic.png", nil)
	w = httptest.NewRecorder()
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

func TestPathAllowedSymlink(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "allowed")
	outside := filepath.Join(dir, "outside")
	_ = os.MkdirAll(allowed, 0o755)
	_ = os.MkdirAll(outside, 0o755)
	secret := filepath.Join(outside, "secret.png")
	_ = os.WriteFile(secret, []byte("x"), 0o644)
	AllowImageDir(allowed)
	if !PathAllowed(filepath.Join(allowed, "a.png")) {
		t.Fatal("白名单内普通路径应放行")
	}
	link := filepath.Join(allowed, "link.png")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("当前环境无法创建符号链接: %v", err)
	}
	if PathAllowed(link) {
		t.Fatal("指向白名单外的符号链接必须拒绝")
	}
}

func serveImgPath(p string) int {
	req := httptest.NewRequest("GET", "/mdimg/"+hex.EncodeToString([]byte(p))+"/x.png", nil)
	w := httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	return w.Code
}

func TestImgHandlerTraversal(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "allowed")
	outside := filepath.Join(dir, "outside")
	for _, d := range []string{allowed, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(filepath.Join(allowed, "pic.png"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(outside, "secret.png"), []byte("x"), 0o644)
	AllowImageDir(allowed)

	// 解码后 .. 归一化仍在白名单内：应放行
	inside := filepath.Join(allowed, "sub", "..", "pic.png")
	if code := serveImgPath(inside); code != 200 {
		t.Fatalf("白名单内归一化路径应放行: %d", code)
	}
	// 解码后 .. 逃逸到兄弟目录：必须拒绝
	escape := filepath.Join(allowed, "..", "outside", "secret.png")
	if code := serveImgPath(escape); code != 403 {
		t.Fatalf(".. 逃逸路径应 403: %d", code)
	}
	// 前缀相近的兄弟目录不能借白名单前缀混入
	sibling := filepath.Join(dir, "allowed-evil", "secret.png")
	if err := os.MkdirAll(filepath.Dir(sibling), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(sibling, []byte("x"), 0o644)
	if code := serveImgPath(sibling); code != 403 {
		t.Fatalf("白名单前缀相近目录应 403: %d", code)
	}
}

func TestPathAllowedSymlinkDir(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "allowed")
	outside := filepath.Join(dir, "outside")
	if err := os.MkdirAll(allowed, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(outside, "secret.png")
	_ = os.WriteFile(secret, []byte("x"), 0o644)
	AllowImageDir(allowed)

	link := filepath.Join(allowed, "link")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("当前环境无法创建符号链接: %v", err)
	}
	if PathAllowed(filepath.Join(link, "secret.png")) {
		t.Fatal("经符号链接目录逃逸到白名单外必须拒绝")
	}
}

func TestImgHandlerMethod(t *testing.T) {
	req := httptest.NewRequest("POST", "/mdimg/00", nil)
	w := httptest.NewRecorder()
	ImgHandler.ServeHTTP(w, req)
	if w.Code != 405 {
		t.Fatalf("非 GET/HEAD 应 405: %d", w.Code)
	}
}
