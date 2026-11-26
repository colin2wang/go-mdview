package storage

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"mdview/internal/settings"
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
	if st.ViewMode != settings.ViewModeRender {
		t.Fatalf("默认视图模式不符: %q", st.ViewMode)
	}
	if !st.LineNo {
		t.Fatalf("行号默认应开启: %+v", st)
	}
	st.Theme = "night"
	st.FontSize = 99
	st.SidebarWidth = 10
	st.ViewMode = "bogus"
	st.LineNo = false
	got := s.SaveSettings(st)
	if got.Theme != "light" || got.FontSize != 28 || got.SidebarWidth != 200 {
		t.Fatalf("clamp 失败: %+v", got)
	}
	if got.ViewMode != settings.ViewModeRender {
		t.Fatalf("非法视图模式未回落: %q", got.ViewMode)
	}
	if s.GetSettings().ViewMode != settings.ViewModeRender {
		t.Fatal("视图模式未落盘")
	}
	if s.GetSettings().FontSize != 28 {
		t.Fatal("设置未落盘")
	}
	if s.GetSettings().LineNo {
		t.Fatal("行号开关未落盘")
	}
}

func TestSettingsLineNoLegacyFile(t *testing.T) {
	s := newTestStore(t)
	// 旧版 settings.json 没有 lineNo 字段：应按默认值显示行号
	_ = os.WriteFile(filepath.Join(s.base(), "settings.json"), []byte(`{"theme":"dark"}`), 0o644)
	st := s.GetSettings()
	if !st.LineNo || st.Theme != "dark" {
		t.Fatalf("旧版设置补齐失败: %+v", st)
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

func TestWatcherSwitchNoPanic(t *testing.T) {
	s := newTestStore(t)
	dir := t.TempDir()
	p1 := filepath.Join(dir, "a.md")
	p2 := filepath.Join(dir, "b.md")
	_ = os.WriteFile(p1, []byte("a"), 0o644)
	_ = os.WriteFile(p2, []byte("b"), 0o644)
	s.SetFileChangeCallback(func(FileEvent) {})
	for i := 0; i < 20; i++ {
		s.WatchFile(p1)
		s.WatchFile(p2)
	}
	s.StopWatch()
	time.Sleep(50 * time.Millisecond)
}

func TestWatcherSuppressesOnlyOwnWrites(t *testing.T) {
	s := newTestStore(t)
	p := filepath.Join(t.TempDir(), "w.md")
	_ = os.WriteFile(p, []byte("v1"), 0o644)
	ch := make(chan FileEvent, 1)
	s.SetFileChangeCallback(func(ev FileEvent) {
		select {
		case ch <- ev:
		default:
		}
	})
	s.WatchFile(p)
	s.MarkSaved()
	_ = os.WriteFile(p, []byte("external-change"), 0o644)
	select {
	case ev := <-ch:
		if ev.Kind != "changed" {
			t.Fatalf("期望 changed，收到 %q", ev.Kind)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("2 秒抑制窗口内的外部修改被吞掉了")
	}
	s.StopWatch()
}

func TestYamlRoundTripAndMindmap(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("MDVIEW_YAML", filepath.Join(dir, "mdview.yml"))
	s := newTestStore(t)
	in := s.GetSettings()
	in.ViewMode = settings.ViewModeMindmap
	in.Language = "de"
	in.UseYaml = true
	in.RemoteAllow = "https://a.b/*\nhttps://c.d"
	got := s.SaveSettings(in)
	if got.ViewMode != settings.ViewModeMindmap || got.Language != "de" {
		t.Fatalf("SaveSettings 返回值漂移: %+v", got)
	}
	raw, err := os.ReadFile(YamlConfigPath())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "viewMode: mindmap") {
		t.Fatalf("yml 未含 mindmap: %s", raw)
	}
	reread := s.GetSettings()
	if reread.ViewMode != settings.ViewModeMindmap || reread.Language != "de" {
		t.Fatalf("yml 往返失败: %+v", reread)
	}
}
