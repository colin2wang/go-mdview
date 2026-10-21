// Command genicon 由矢量描述生成 mdview 的位图图标资源：
//
//	build/appicon.png      1024×1024，Wails 用它生成可执行文件图标
//	build/windows/icon.ico 多尺寸 ICO，用于 exe 资源与 NSIS 安装包
//	build/mdview.markdown.png  512×512，wails.json 文件关联（iconName）所需
//	docs/mdview.ico        仓库内留档
//
// 图形与 docs/mdview-icon.svg 保持一致：蓝色圆角方块 + 白色粗体 M。
// 这里按"描边折线"方式光栅化 M（等价于 SVG 的 stroke + round 端点/连接），
// 只依赖标准库，不需要额外的字体或 SVG 渲染依赖。
//
// 用法：
//
//	go run ./tools/genicon
package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"runtime"
)

// ---- 图形参数（1024×1024 设计稿坐标） ----

const (
	canvas    = 1024.0 // 设计稿边长
	pad       = 28.0   // 圆角方块外边距
	radius    = 200.0  // 圆角半径
	stroke    = 148.0  // M 的笔画宽度
	glyphTop  = 330.0
	glyphBot  = 690.0
	glyphL    = 250.0
	glyphR    = 774.0
	glyphMidY = 640.0
	half      = canvas / 2
)

// M 的骨架折线：左下 → 左上 → 中间谷底 → 右上 → 右下。
var glyph = [][2]float64{
	{glyphL, glyphBot},
	{glyphL, glyphTop},
	{half, glyphMidY},
	{glyphR, glyphTop},
	{glyphR, glyphBot},
}

var (
	bgTop    = color.NRGBA{0x34, 0x74, 0xF4, 0xFF}
	bgBottom = color.NRGBA{0x2B, 0x64, 0xE6, 0xFF}
	glyphCol = color.NRGBA{0xFF, 0xFF, 0xFF, 0xFF}
)

func main() {
	root, err := repoRoot()
	if err != nil {
		fatal(err)
	}

	// 1) 1024 PNG：Wails 构建时据此生成 exe 图标
	if err := writePNG(filepath.Join(root, "build", "appicon.png"), 1024); err != nil {
		fatal(err)
	}
	// 2) 多尺寸 ICO（PNG 压缩条目，Windows Vista+ 原生支持）
	sizes := []int{16, 20, 24, 32, 40, 48, 64, 96, 128, 256}
	ico := filepath.Join(root, "build", "windows", "icon.ico")
	if err := writeICO(ico, sizes); err != nil {
		fatal(err)
	}
	if err := copyFile(ico, filepath.Join(root, "docs", "mdview.ico")); err != nil {
		fatal(err)
	}
	// 3) 文件关联图标：wails.json 里 info.fileAssociations[].iconName="mdview.markdown"，
	//    wails 用 buildassets.ReadFile 读取，路径是 <build 目录>/mdview.markdown.png，
	//    再由 winicon 转成 build/windows/mdview.markdown.ico 供安装包注册文件类型图标
	if err := writePNG(filepath.Join(root, "build", "mdview.markdown.png"), 512); err != nil {
		fatal(err)
	}

	fmt.Println("icon: build/appicon.png (1024)")
	fmt.Printf("icon: build/windows/icon.ico (%v)\n", sizes)
	fmt.Println("icon: docs/mdview.ico")
	fmt.Println("icon: build/mdview.markdown.png (512)")
}

// ---------- 光栅化 ----------

// render 生成 size×size 的 RGBA 图标（带 4×4 超采样抗锯齿）。
func render(size int) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	const ss = 4 // 每边采样数
	step := 1.0 / float64(ss)
	scale := canvas / float64(size)
	total := float64(ss * ss)

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				py := (float64(y) + (float64(sy)+0.5)*step) * scale
				for sx := 0; sx < ss; sx++ {
					px := (float64(x) + (float64(sx)+0.5)*step) * scale
					c := colorAt(px, py)
					r += float64(c.R)
					g += float64(c.G)
					b += float64(c.B)
					a += float64(c.A)
				}
			}
			img.SetNRGBA(x, y, color.NRGBA{
				R: uint8(r / total),
				G: uint8(g / total),
				B: uint8(b / total),
				A: uint8(a / total),
			})
		}
	}
	return img
}

// colorAt 返回设计稿坐标 (x, y) 处的颜色（含透明背景）。
func colorAt(x, y float64) color.NRGBA {
	if !inRoundRect(x, y) {
		return color.NRGBA{}
	}
	if distToGlyph(x, y) <= stroke/2 {
		return glyphCol
	}
	if y < half {
		return bgTop
	}
	return bgBottom
}

// inRoundRect 判断点是否落在圆角方块内。
func inRoundRect(x, y float64) bool {
	if x < pad || x > canvas-pad || y < pad || y > canvas-pad {
		return false
	}
	cx := math.Min(math.Max(x, pad+radius), canvas-pad-radius)
	cy := math.Min(math.Max(y, pad+radius), canvas-pad-radius)
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= radius*radius
}

// distToGlyph 点到 M 骨架折线的最短距离（round join/cap 的自然结果）。
func distToGlyph(x, y float64) float64 {
	best := math.Inf(1)
	for i := 0; i < len(glyph)-1; i++ {
		if d := segDist(x, y, glyph[i], glyph[i+1]); d < best {
			best = d
		}
	}
	return best
}

func segDist(px, py float64, a, b [2]float64) float64 {
	vx, vy := b[0]-a[0], b[1]-a[1]
	wx, wy := px-a[0], py-a[1]
	l2 := vx*vx + vy*vy
	t := 0.0
	if l2 > 0 {
		t = (wx*vx + wy*vy) / l2
		if t < 0 {
			t = 0
		} else if t > 1 {
			t = 1
		}
	}
	return math.Hypot(wx-t*vx, wy-t*vy)
}

// ---------- 输出 ----------

func writePNG(path string, size int) error {
	var buf bytes.Buffer
	if err := png.Encode(&buf, render(size)); err != nil {
		return err
	}
	return writeFile(path, buf.Bytes())
}

func writeICO(path string, sizes []int) error {
	var entries []icoEntry
	for _, s := range sizes {
		var buf bytes.Buffer
		if err := png.Encode(&buf, render(s)); err != nil {
			return err
		}
		entries = append(entries, icoEntry{size: s, data: buf.Bytes()})
	}

	var out bytes.Buffer
	// ICONDIR
	binary.Write(&out, binary.LittleEndian, uint16(0)) // reserved
	binary.Write(&out, binary.LittleEndian, uint16(1)) // type: icon
	binary.Write(&out, binary.LittleEndian, uint16(len(entries)))

	// ICONDIRENTRY：数据区起始偏移
	offset := 6 + 16*len(entries)
	for i := range entries {
		e := &entries[i]
		b := byte(e.size)
		if e.size >= 256 {
			b = 0 // 256 用 0 表示
		}
		out.WriteByte(b)                                    // width
		out.WriteByte(b)                                    // height
		out.WriteByte(0)                                    // color count
		out.WriteByte(0)                                    // reserved
		binary.Write(&out, binary.LittleEndian, uint16(1))  // planes
		binary.Write(&out, binary.LittleEndian, uint16(32)) // bit count
		binary.Write(&out, binary.LittleEndian, uint32(len(e.data)))
		binary.Write(&out, binary.LittleEndian, uint32(offset))
		offset += len(e.data)
	}
	for _, e := range entries {
		out.Write(e.data)
	}
	return writeFile(path, out.Bytes())
}

type icoEntry struct {
	size int
	data []byte
}

func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return writeFile(dst, b)
}

func repoRoot() (string, error) {
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		return "", fmt.Errorf("cannot locate source file")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(self), "..", "..")), nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "genicon:", err)
	os.Exit(1)
}
