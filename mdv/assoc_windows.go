//go:build windows

package mdv

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"golang.org/x/sys/windows/registry"
)

// 文件关联全部写在 HKEY_CURRENT_USER\Software\Classes 下：
// 不需要管理员权限，卸载（取消关联）时也能干净回滚。
const (
	assocProgID = "mdview.markdown" // .md 指向的 ProgID
	assocAppKey = `Software\Classes\Applications\mdview.exe`
	assocCfgKey = `Software\mdview\FileAssoc` // 备份原关联，供取消时还原
)

// AssocExts 支持关联的扩展名。
var AssocExts = []string{".md", ".markdown"}

// ExePath 当前可执行文件的绝对路径（解析符号链接后）。
func ExePath() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if abs, err := filepath.EvalSymlinks(p); err == nil {
		return abs
	}
	return p
}

func assocIconValue() string    { return `"` + ExePath() + `",0` }
func assocCommandValue() string { return `"` + ExePath() + `" "%1"` }

// GetAssocState 读取当前 .md 的关联情况。
func GetAssocState() AssocState {
	st := AssocState{Supported: true, ExePath: ExePath(), Owner: "（未设置）"}
	if st.ExePath == "" {
		st.Message = "无法定位可执行文件路径"
		return st
	}
	st.Associated = IsAssociated()
	owner := readDefault(registry.CURRENT_USER, `Software\Classes\`+AssocExts[0])
	if owner == "" {
		return st
	}
	if strings.EqualFold(owner, assocProgID) {
		st.Owner = "mdview"
		return st
	}
	st.Owner = friendlyName(owner)
	return st
}

// IsAssociated 所有受管扩展名是否都指向 mdview。
func IsAssociated() bool {
	for _, ext := range AssocExts {
		v := readDefault(registry.CURRENT_USER, `Software\Classes\`+ext)
		if !strings.EqualFold(v, assocProgID) {
			return false
		}
	}
	return true
}

// AssociateMd 把 .md/.markdown 的默认打开方式设为当前 mdview 并设置文件图标。
func AssociateMd() error {
	exe := ExePath()
	if exe == "" {
		return errors.New("无法定位可执行文件路径")
	}

	// 1) 写 ProgID：显示名、图标、打开命令
	if err := createKey(`Software\Classes\`+assocProgID, func(k registry.Key) error {
		if err := k.SetStringValue("", "Markdown 文档"); err != nil {
			return err
		}
		if err := k.SetStringValue("FriendlyTypeName", "Markdown 文档"); err != nil {
			return err
		}
		return k.SetStringValue("DefaultIcon", assocIconValue())
	}); err != nil {
		return err
	}
	if err := createKey(`Software\Classes\`+assocProgID+`\shell\open\command`, func(k registry.Key) error {
		return k.SetStringValue("", assocCommandValue())
	}); err != nil {
		return err
	}

	// 2) 注册应用本体：让“打开方式”列表里出现 mdview
	if err := createKey(assocAppKey, func(k registry.Key) error {
		if err := k.SetStringValue("FriendlyAppName", "mdview"); err != nil {
			return err
		}
		return k.SetStringValue("DefaultIcon", assocIconValue())
	}); err != nil {
		return err
	}
	if err := createKey(assocAppKey+`\shell\open\command`, func(k registry.Key) error {
		return k.SetStringValue("", assocCommandValue())
	}); err != nil {
		return err
	}

	// 3) 先把接管前的默认值备份到 Software\mdview\FileAssoc，取消关联时还原
	for _, ext := range AssocExts {
		prev := readDefault(registry.CURRENT_USER, `Software\Classes\`+ext)
		if prev == "" || strings.EqualFold(prev, assocProgID) {
			continue
		}
		if readValue(registry.CURRENT_USER, assocCfgKey, ext) != "" {
			continue // 先前已备份过，别把后来接管的程序记成原始值
		}
		if err := createKey(assocCfgKey, func(k registry.Key) error {
			return k.SetStringValue(ext, prev)
		}); err != nil {
			return err
		}
	}
	for _, ext := range AssocExts {
		if err := createKey(`Software\Classes\`+ext, func(k registry.Key) error {
			return k.SetStringValue("", assocProgID)
		}); err != nil {
			return err
		}
		// 同时挂进 OpenWithProgids，"打开方式"里始终能看到 mdview
		if err := createKey(`Software\Classes\`+ext+`\OpenWithProgids`, func(k registry.Key) error {
			return k.SetStringValue(assocProgID, "")
		}); err != nil {
			return err
		}
	}

	notifyShell()
	return nil
}

// UnassociateMd 取消关联：还原接管前的默认打开方式（没有备份就清空默认值）。
func UnassociateMd() error {
	for _, ext := range AssocExts {
		cur := readDefault(registry.CURRENT_USER, `Software\Classes\`+ext)
		if !strings.EqualFold(cur, assocProgID) {
			continue // 已被其它程序接管，不要动它
		}
		backup := readValue(registry.CURRENT_USER, assocCfgKey, ext)
		if err := createKey(`Software\Classes\`+ext, func(k registry.Key) error {
			if backup != "" {
				return k.SetStringValue("", backup)
			}
			return deleteValue(k, "")
		}); err != nil {
			return err
		}
		// 移除我们加的 OpenWithProgids 条目
		deleteValueByPath(`Software\Classes\`+ext+`\OpenWithProgids`, assocProgID)
	}

	_ = deleteTree(`Software\Classes\` + assocProgID)
	_ = deleteTree(assocAppKey)
	_ = deleteTree(assocCfgKey)
	notifyShell()
	return nil
}

// ---------- 注册表小工具 ----------

func createKey(path string, fn func(k registry.Key) error) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path,
		registry.QUERY_VALUE|registry.SET_VALUE|registry.CREATE_SUB_KEY)
	if err != nil {
		return fmt.Errorf("写入注册表失败 %s: %w", path, err)
	}
	defer k.Close()
	return fn(k)
}

func openKey(path string) (registry.Key, error) {
	return registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE|registry.SET_VALUE)
}

// readDefault 读取键的默认值（不存在返回空串）。
func readDefault(root registry.Key, path string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}

// readValue 读取指定键下的字符串值。
func readValue(root registry.Key, path, name string) string {
	k, err := registry.OpenKey(root, path, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(v)
}

func deleteValue(k registry.Key, name string) error {
	if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func deleteValueByPath(path, name string) {
	k, err := openKey(path)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.DeleteValue(name)
}

// deleteTree 递归删除键及其子键（键不存在视为成功）。
func deleteTree(path string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return nil
		}
		return err
	}
	names, err := k.ReadSubKeyNames(-1)
	k.Close()
	if err == nil {
		for _, n := range names {
			_ = deleteTree(path + `\` + n)
		}
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

// friendlyName 把 ProgID 尽量翻译成用户可读的程序名。
func friendlyName(progID string) string {
	for _, p := range []string{`Software\Classes\` + progID, `Software\Classes\Applications\` + progID} {
		if v := readDefault(registry.CURRENT_USER, p); v != "" && !strings.HasPrefix(v, "@") {
			return v
		}
		if v := readValue(registry.CURRENT_USER, p, "FriendlyAppName"); v != "" && !strings.HasPrefix(v, "@") {
			return v
		}
	}
	return progID
}

// ---------- 通知资源管理器刷新图标 ----------

const (
	shcneAssocChanged = 0x08000000
	shcnfIDList       = 0x00000000
	shcnfFlush        = 0x00001000
)

// notifyShell 广播“关联已变更”，让资源管理器立即换图标。
// 失败不影响关联结果（用户重启资源管理器/注销后也会生效）。
func notifyShell() {
	dll := syscall.NewLazyDLL("shell32.dll")
	proc := dll.NewProc("SHChangeNotify")
	if proc == nil || proc.Find() != nil {
		return
	}
	syscall.SyscallN(proc.Addr(),
		uintptr(shcneAssocChanged),
		uintptr(shcnfIDList|shcnfFlush),
		0,
		0)
	// Windows 10/11 上再刷一次图标缓存，避免资源管理器仍显示旧图标
	refreshIconCache()
}

// refreshIconCache 调用系统自带的 ie4uinit（失败完全忽略）。
func refreshIconCache() {
	cmd := exec.Command("ie4uinit.exe", "-show")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
