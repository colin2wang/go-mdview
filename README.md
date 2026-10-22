# mdview · User Guide

A lightweight local Markdown reader for Windows (a clone of mdview.cn) — double-click a `.md` file and read it like a web page, no configuration needed.

> Tech stack: Go 1.25 + Wails v2 + Vue 3 + TypeScript · Ships as a single-file `mdview.exe` (~13MB)

---

## 1. Quick Start

| Method | How |
| --- | --- |
| Double-click | Associate `mdview.exe` with `.md` files (one click in Settings), or drop a file onto the exe |
| Drag & drop | Drag a `.md` file anywhere into the mdview window |
| Send To | `Win+R` → `shell:sendto` → put an `mdview.exe` shortcut there, then right-click an md file → Send To → mdview |
| Command line | `mdview.exe "D:\notes\xxx.md"` |
| Open a folder | Left sidebar "Files" tab → "Open Directory" — pick a notes folder (e.g. an Obsidian vault) and all `.md` files are listed automatically |

**Single instance**: double-clicking again won't open a new window — the file is handed to the already-running one.

## 2. UI Tour

The whole window at a glance — custom draggable title bar up top, the four tabs down the left, content on the right (rendered body is centered at 900px with 40px top padding). Shown here in Split view, with the source-pane toolbar offering Sync scroll / Edit / Save / Copy:

![Split view: source on the left, rendered result on the right](docs/images/split-view.png)

### The four tabs

- **TOC**: automatically extracts headings into an outline tree, highlights the current section while scrolling, click to smooth-scroll
- **History**: recently opened files (up to 100 entries) with directory and relative time; keyword filter at the top, clear-all at the top right
- **Favorites**: right-click any file → Favorite; entries show a ★ that unfavorites with one click
- **Files**: file tree of the current directory (Markdown plus previewable images/text; hidden and junk directories like `.obsidian`/`.git`/`node_modules` are skipped automatically); the open file gets a "current" badge; supports open directory / refresh / collapse all

### Title bar buttons

Three view modes — `Source` · `Render` · `Split` (grayed out when no file is open) — then `⚙ Settings` · `⛶ Fullscreen` · `📌 Always on top` · `─ Minimize` · `□ Maximize` · `✕ Close` (double-click the title bar = maximize/restore).

- **Render**: the rendered result only (default)
- **Source**: the raw Markdown text only — header shows path, line count / encoding / size, with one-click copy-all; line numbers can be toggled in Settings
- **Split**: source on the left, rendered result on the right, with a draggable divider (double-click it to split evenly); a **Sync scroll** toggle keeps both panes aligned

**Live editing (Split view)**: click **Edit** to rewrite the Markdown on the left and watch the right pane update instantly. Changes stay preview-only until you click **Save**, which writes them back to the original file (GB18030 notes are saved in their original encoding via an atomic replace). Switching files while unsaved edits exist warns that they'll be discarded. Scroll positions are remembered separately for each pane and survive switching.

### Context menus

- **Right-click on content**: light/dark theme toggle · enter/exit Split view · copy file path · open containing folder · export HTML
- **Right-click on Files/History/Favorites entries**: open · favorite/unfavorite · copy file path · open containing folder

### Screenshots

**Mermaid & SVG diagrams** render inline as cards; each card header has a **Source** button to flip between the graphic and its code, plus a copy button:

![Mermaid diagram rendered in Split view](docs/images/split-mermaid.png)

**Files panel** — a directory tree of your notes folder (left) alongside the rendered document (right), here showing an inline SVG graphic:

![Files tree panel with rendered SVG graphic](docs/images/files-tree.png)

**Settings** — theme, UI language, body font size, code wrap, default view, line numbers, always-on-top, and one-click `.md` file association:

![Settings dialog](docs/images/settings.png)

## 3. Rendering Capabilities

- Full GFM: tables (rounded borders), strikethrough, task lists (checkable style), autolinks
- Code blocks: highlight.js syntax highlighting (github / github-dark themes follow the global theme), language label at the top right, copy button on hover
- GFM Alerts: `> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]` callouts in five colors
- Math: `$inline$` and `$$block$$` (KaTeX, rendered offline)
- Mermaid diagrams: ```mermaid code blocks render as card-style diagrams (falls back to showing the source on syntax errors)
- SVG graphics: ```svg (or xml/html blocks whose content is an `<svg>`) render directly as a graphic card
- Every diagram/graphic card has a **Source** button to toggle between the graphic and its raw code, plus a copy button
- Footnotes `[^1]`, `==highlight==`, `[[wiki links]]` (wiki links resolve by title within the current directory and navigate automatically)
- Local images: PNG/JPG/SVG/GIF/WebP in the md file's directory and subdirectories display directly (built-in replay route — files never leave your machine)
- Standalone preview: opening an image file shows it in a lightbox; opening a plain-text file shows it as-is
- Global light/dark theme toggle (code highlight theme follows), font size 12–28px, code block word-wrap toggle — all auto-saved
- UI in four languages — Simplified Chinese, English, Japanese, German — switchable live in Settings

## 4. FAQ

**Q1: Double-clicking an md file doesn't open mdview?**
Open "⚙ Settings → File Association" and click "Associate with mdview" (writes to `HKEY_CURRENT_USER`, no admin rights needed; "Unassociate" restores the previous default). Or manually: right-click the md file → Open With → choose mdview.exe → check "Always use this app".

**Q2: Do old notes with Chinese/GBK encoding show mojibake?**
UTF-8 / GB18030 is auto-detected; no manual conversion needed.

**Q3: History entry won't open after the file was moved/deleted?**
Missing files in History and Favorites appear grayed out; clicking shows a "file not found" message.

**Q4: Can I edit the Markdown?**
Yes — switch to **Split** view, click **Edit**, and the right pane previews your changes live; **Save** writes them back to the original file (original encoding preserved). It's a lightweight in-place editor, not a full authoring suite — for heavy editing open the file in your own editor.

**Q5: Where are settings and data stored?**
`%AppData%\mdview\` (settings.json / history.json / favorites.json); delete them to reset.

**Q6: Clicking a wiki link `[[some note]]` does nothing?**
Wiki links search the directory of the currently open file recursively for an md with a matching name (without extension); a message appears if not found. Make sure the target note is in the same directory tree.

## 5. Known Limitations (stated honestly)

- Editing is a lightweight in-place source editor (Split view → Edit/Save), not a full authoring tool; other official mdview Pro features (PDF export, archive management, etc.) are out of scope for this clone
- HTML export is a simplified single-file layout (embedded base styles), not the official "bundle-with-images" capability
- Large Mermaid diagrams take 1–2 seconds to parse on first render (the ~2.7MB library is bundled — no network dependency)

## 6. Building from Source

```
go-mdview/
├── main.go                   # Wails entry (frameless window, single instance, embed)
├── internal/app/             # Binding layer exposed to the frontend (App.*)
├── internal/mdv/             # Domain logic (settings/history/favorites/file tree/encoding detection/image serving/export/association)
│   └── *_test.go             # Go unit tests
├── frontend/src/             # Vue 3 + TS SPA (title bar/four tabs/render pipeline)
├── frontend/public/static/   # highlight.js / KaTeX / mermaid local libraries
├── build.ps1                 # One-click Windows build (-Clean / -Package)
└── wails.json / go.mod
```

```powershell
# Requires: Go 1.25+, Node 18+, pnpm, (recommended) wails CLI v2
.\build.ps1            # Incremental build (icons → frontend → exe)
.\build.ps1 -Clean     # Clean build
.\build.ps1 -Package   # Build + zip
```

The script runs `generate-icon.ps1`, then `pnpm install && pnpm run build` in `frontend/` (vue-tsc type check + vite build), then `wails build` (falling back to `go build -tags "desktop,production"` if the wails CLI is missing). Output: `build\bin\mdview.exe`.

Run Go tests: `go test ./internal/mdv/`.

---

*mdview clone · Built with Go + Wails · Files are processed 100% locally — no data is ever uploaded*
