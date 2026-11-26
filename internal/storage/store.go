// Package storage 统一持久化：settings / history / favorites 三份 JSON 的
// 原子读写（temp+rename）、外部修改监视门面、exe 同目录 mdview.yml 配置源。
package storage

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"

	"mdview/internal/fsops"
	"mdview/internal/settings"
	"mdview/internal/watcher"
)

// FileEvent 外部文件事件别名（内部监视器包的类型，对绑定层保持 storage 命名空间）。
type FileEvent = watcher.FileEvent

// Node / FileContent 别名：目录树与编码读写的类型在 internal/fsops。
type (
	Node        = fsops.Node
	FileContent = fsops.FileContent
)

// Store 管理三份 JSON 持久化数据：settings / history / favorites。
// 全部落在 os.UserConfigDir()/mdview/ 下，原子写（temp+rename）。
type Store struct {
	mu      sync.Mutex
	once    sync.Once
	baseDir string
	// 文件外部修改监视（见 internal/watcher）：值语义字段，Store 零值即可用
	watcher watcher.Watcher

	// 最近一次持久化错误：前端保存设置后可取回提示，同时写本地日志。
	errMu   sync.Mutex
	lastErr string
}

// LastError 返回并清空最近一次持久化错误（前端每次保存后取一次）。
func (s *Store) LastError() string {
	s.errMu.Lock()
	defer s.errMu.Unlock()
	v := s.lastErr
	s.lastErr = ""
	return v
}

func (s *Store) setError(err error) {
	if err == nil {
		return
	}
	s.errMu.Lock()
	s.lastErr = err.Error()
	s.errMu.Unlock()
	log.Printf("mdview: %v", err)
}

func NewStore() *Store {
	return &Store{}
}

// SetFileChangeCallback 注册外部修改事件回调（转发 internal/watcher）。
func (s *Store) SetFileChangeCallback(cb func(FileEvent)) { s.watcher.SetFileChangeCallback(cb) }

// WatchFile 监视 path 的外部修改；切换文件时自动替换旧的监视目标。
func (s *Store) WatchFile(path string) { s.watcher.WatchFile(path) }

// StopWatch 停止监视当前文件（关闭文件/退出时调用）。
func (s *Store) StopWatch() { s.watcher.Stop() }

// MarkSaved 在本应用写盘后调用，把自身写入抑制窗口设为当下。
func (s *Store) MarkSaved() { s.watcher.MarkSaved() }

// ---------- 目录树 / wiki 索引 / 编码读写（转发 internal/fsops） ----------

// InvalidateTreeCache 让下一次 ListTree 重新扫描磁盘。
func InvalidateTreeCache() { fsops.InvalidateTreeCache() }

// ListTree 扫描 root 下的目录与 markdown 文件。
func (s *Store) ListTree(root string) ([]Node, error) { return fsops.ListTree(root) }

// FindByTitles 返回同名笔记的全部候选（wiki 链接消歧）。
func (s *Store) FindByTitles(root, title string) []string { return fsops.FindByTitles(root, title) }

// FindByTitle 返回第一个同名匹配，找不到返回空串。
func (s *Store) FindByTitle(root, title string) string { return fsops.FindByTitle(root, title) }

// ReadMarkdown 读取 .md 文本（BOM/UTF-8/GB18030/Big5/Shift-JIS 自动探测）。
func (s *Store) ReadMarkdown(path string) (FileContent, error) { return fsops.ReadFile(path) }

// SaveMarkdown 把编辑后的正文按原编码/BOM/CRLF 原子写回文件。
func (s *Store) SaveMarkdown(path, content, encoding string) (FileContent, error) {
	return fsops.SaveFile(path, content, encoding)
}

// StatFile 判断文件是否仍存在（顺手返回修改时间）。
func (s *Store) StatFile(path string) (int64, bool) { return fsops.StatFile(path) }

// ---------- JSON 持久化 ----------

func (s *Store) base() string {
	// baseDir 一经确定不再变化，用 sync.Once 只算一次：Wails 绑定方法由
	// 不同 goroutine 并发进入，原先「判空再写」在首次并发调用下有数据竞争；
	// 又不能直接加 s.mu——writeJSON 持锁时会再调 base()，造成不可重入死锁。
	s.once.Do(func() {
		if os.Getenv("MDVIEW_HOME") != "" { // 测试与便携模式可覆盖
			s.baseDir = os.Getenv("MDVIEW_HOME")
		} else {
			cfg, err := os.UserConfigDir()
			if err != nil {
				home, _ := os.UserHomeDir()
				s.baseDir = filepath.Join(home, ".mdview")
			} else {
				s.baseDir = filepath.Join(cfg, "mdview")
			}
		}
		_ = os.MkdirAll(s.baseDir, 0o755)
	})
	return s.baseDir
}

func (s *Store) readJSON(name string, v interface{}) error {
	path := filepath.Join(s.base(), name)
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			s.setError(err)
		}
		return err
	}
	if err := json.Unmarshal(data, v); err != nil {
		s.setError(err)
		return err
	}
	return nil
}

func (s *Store) writeJSON(name string, v interface{}) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		s.setError(err)
		return err
	}
	target := filepath.Join(s.base(), name)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		s.setError(err)
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		s.setError(err)
		return err
	}
	return nil
}

// ---------- 设置 ----------

// GetSettings 读取设置并补齐默认值/合法区间。
func (s *Store) GetSettings() settings.Settings {
	// 以默认值开局再反序列化：旧版 settings.json 缺字段（如 lineNo）时保留默认值
	st := settings.DefaultSettings
	s.mu.Lock()
	s.readJSON("settings.json", &st)
	s.mu.Unlock()
	// yml 配置源优先：exe 同目录存在 mdview.yml 即视为开关打开（不必依赖存储的
	// useYaml 值），yml 中出现的键覆盖 JSON
	if yamlExists() && !yamlDisabled() {
		st.UseYaml = true
		loadYamlSettings(&st)
	} else if yamlDisabled() {
		st.UseYaml = false // 用户已关闭 yml，即使文件因权限删不掉也不让它复活
	}
	settings.Normalize(&st)
	return st
}

// SaveSettings 校验后落盘。
func (s *Store) SaveSettings(in settings.Settings) settings.Settings {
	st := in
	settings.Clamp(&st)
	s.mu.Lock()
	if st.UseYaml {
		// yml 模式：只要开关打开就写 mdview.yml（首次打开开关时立即创建带注释的
		// 文件），settings.json 不再更新；写失败时回落 JSON，避免设置丢失
		if err := writeYamlSettings(st); err != nil {
			s.setError(err) // 写 yml 失败也要可见，不再静默回落
			s.writeJSON("settings.json", &st)
		}
	} else {
		// 关掉 yml 开关：回写 settings.json，并删除本地 yml，
		// 避免残留旧文件让下次启动又把开关「顶」回打开状态
		s.writeJSON("settings.json", &st)
		if err := removeYaml(); err != nil {
			s.setError(err)
		}
	}
	s.mu.Unlock()
	return st
}
