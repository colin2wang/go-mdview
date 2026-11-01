// Package mdv 提供 mdview 的核心领域逻辑：设置/历史/收藏持久化、
// 目录树扫描、markdown 文件读取（含 GBK 兼容）、本地图片回放、HTML 导出。
package mdv

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Store 管理三份 JSON 持久化数据：settings / history / favorites。
// 全部落在 os.UserConfigDir()/mdview/ 下，原子写（temp+rename）。
type Store struct {
	mu      sync.Mutex
	once    sync.Once
	baseDir string
	// 文件外部修改监视（见 watcher.go）：值语义字段，Store 零值即可用
	watcher watcherState
}

func NewStore() *Store {
	return &Store{}
}

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

func (s *Store) readJSON(name string, v interface{}) {
	data, err := os.ReadFile(filepath.Join(s.base(), name))
	if err != nil {
		return
	}
	_ = json.Unmarshal(data, v)
}

func (s *Store) writeJSON(name string, v interface{}) {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return
	}
	target := filepath.Join(s.base(), name)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, target)
}
