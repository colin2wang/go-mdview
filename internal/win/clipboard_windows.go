//go:build windows

package win

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32DLL   = windows.NewLazySystemDLL("user32.dll")
	kernel32DLL = windows.NewLazySystemDLL("kernel32.dll")

	procOpenClipboard    = user32DLL.NewProc("OpenClipboard")
	procCloseClipboard   = user32DLL.NewProc("CloseClipboard")
	procEmptyClipboard   = user32DLL.NewProc("EmptyClipboard")
	procSetClipboardData = user32DLL.NewProc("SetClipboardData")
	procGlobalAlloc      = kernel32DLL.NewProc("GlobalAlloc")
	procGlobalLock       = kernel32DLL.NewProc("GlobalLock")
	procGlobalUnlock     = kernel32DLL.NewProc("GlobalUnlock")
	procGlobalFree       = kernel32DLL.NewProc("GlobalFree")
)

const (
	winCFDIB        = 8
	winGMEMMoveable = 0x0002
)

// CopyImage 把 PNG data URL 解码为 DIB 位图写入剪贴板。
// Wails 自带剪贴板 API 只能写文本，图形卡片的「复制图片」需要真正的位图格式。
func CopyImage(dataURL string) error {
	img, err := decodePngDataURL(dataURL)
	if err != nil {
		return err
	}

	// OpenClipboard/SetClipboardData 必须在同一线程上完成，否则会偶发失败或死锁
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	if r, _, err := procOpenClipboard.Call(0); r == 0 {
		return fmt.Errorf("OpenClipboard: %w", err)
	}
	defer procCloseClipboard.Call()

	if r, _, err := procEmptyClipboard.Call(0); r == 0 {
		return fmt.Errorf("EmptyClipboard: %w", err)
	}

	dib, err := bitmapToDIB(img)
	if err != nil {
		return err
	}
	h, _, err := procGlobalAlloc.Call(winGMEMMoveable, uintptr(len(dib)))
	if h == 0 {
		if err != nil {
			return fmt.Errorf("GlobalAlloc: %w", err)
		}
		return errors.New("GlobalAlloc failed")
	}
	ptr, _, err := procGlobalLock.Call(h)
	if ptr == 0 {
		procGlobalFree.Call(h)
		if err != nil {
			return fmt.Errorf("GlobalLock: %w", err)
		}
		return errors.New("GlobalLock failed")
	}
	copy(unsafe.Slice((*byte)(unsafe.Pointer(ptr)), len(dib)), dib)
	procGlobalUnlock.Call(h)

	// SetClipboardData 成功后系统接管 h，不能再 GlobalFree
	if r, _, err := procSetClipboardData.Call(winCFDIB, h); r == 0 {
		procGlobalFree.Call(h)
		if err != nil {
			return fmt.Errorf("SetClipboardData: %w", err)
		}
		return errors.New("SetClipboardData failed")
	}
	return nil
}

func decodePngDataURL(dataURL string) (image.Image, error) {
	comma := strings.IndexByte(dataURL, ',')
	if comma < 0 || !strings.Contains(dataURL[:comma], "base64") {
		return nil, errors.New("invalid image data url")
	}
	raw, err := base64.StdEncoding.DecodeString(dataURL[comma+1:])
	if err != nil {
		return nil, err
	}
	return png.Decode(bytes.NewReader(raw))
}

// bitmapToDIB 生成 BITMAPINFOHEADER + 自下而上的 BGRA 像素（32 位 CF_DIB）。
func bitmapToDIB(src image.Image) ([]byte, error) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, errors.New("empty image")
	}
	rgba := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(rgba, rgba.Bounds(), src, b.Min, draw.Src)

	const headerSize = 40
	stride := w * 4
	out := make([]byte, headerSize+stride*h)
	le := func(offset int, v uint32) {
		out[offset] = byte(v)
		out[offset+1] = byte(v >> 8)
		out[offset+2] = byte(v >> 16)
		out[offset+3] = byte(v >> 24)
	}
	le(0, headerSize)        // biSize
	le(4, uint32(w))         // biWidth
	le(8, uint32(h))         // biHeight：正数为 bottom-up
	out[12], out[13] = 1, 0  // biPlanes
	out[14], out[15] = 32, 0 // biBitCount
	le(16, 0)                // biCompression = BI_RGB
	le(20, uint32(stride*h)) // biSizeImage

	for y := 0; y < h; y++ {
		srcY := h - 1 - y // DIB 像素自下而上
		for x := 0; x < w; x++ {
			i := rgba.PixOffset(x, srcY)
			o := headerSize + y*stride + x*4
			out[o] = rgba.Pix[i+2]   // B
			out[o+1] = rgba.Pix[i+1] // G
			out[o+2] = rgba.Pix[i]   // R
			out[o+3] = rgba.Pix[i+3] // A（32 位 BI_RGB 通常忽略，保留原值）
		}
	}
	return out, nil
}
