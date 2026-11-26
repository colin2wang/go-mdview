# mdview build script (run on Windows)
# Usage:
#   .\build.ps1            # incremental build (icons if missing + frontend + backend exe)
#   .\build.ps1 -Clean     # clean before building
#   .\build.ps1 -Package   # build and package dist-zip (with docs/source manifest)
#   .\generate-icon.ps1    # regenerate icon assets only
param(
    [switch]$Clean,
    [switch]$Package,
    # 主版本号（显示在设置页 "(1.0.0 build ...)" 中），发布时按需修改
    [string]$Version = "1.0.0"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "==> mdview build (wails v3)" -ForegroundColor Cyan

if ($Clean) {
    Write-Host "==> Cleaning build/dist"
    if (Test-Path "$root\build\bin") { Remove-Item "$root\build\bin" -Recurse -Force }
    if (Test-Path "$root\frontend\dist") { Remove-Item "$root\frontend\dist" -Recurse -Force }
}

# 1) Icons (see generate-icon.ps1; regenerate only when required assets are missing)
$iconAssets = @(
    "$root\build\appicon.png",
    "$root\build\windows\icon.ico",
    "$root\build\mdview.markdown.png"
)
$missingIcons = @($iconAssets | Where-Object { -not (Test-Path $_) })
if ($missingIcons.Count -gt 0) {
    Write-Host "==> Icon assets missing, generating"
    & "$root\generate-icon.ps1"
} else {
    Write-Host "==> Icon assets exist, skip (run .\generate-icon.ps1 to regenerate)"
}

# wails3 usually lives in $(go env GOPATH)\bin, which may be absent from PATH.
# Resolved once here and reused for syso generation below.
$wails3 = (Get-Command wails3 -ErrorAction SilentlyContinue).Source
if (-not $wails3) {
    $fallback = Join-Path (( & go env GOPATH ).Trim()) 'bin\wails3.exe'
    if (Test-Path $fallback) { $wails3 = $fallback }
}
if (-not $wails3) { throw "wails3 CLI not found (PATH and GOPATH\bin); cannot generate bindings" }

# 2) Frontend bindings (generated from internal/app; keeps api.ts imports resolvable
#    even in a fresh clone without a prior manual `wails3 generate bindings`)
Write-Host "==> Generating frontend bindings (wails3)"
& $wails3 generate bindings -ts -d "$root\frontend\bindings"
if ($LASTEXITCODE -ne 0) { throw "bindings generation failed" }

# 3) Frontend
Write-Host "==> Frontend build (vue-tsc + vite + sanitize-check)"
Push-Location "$root\frontend"
if (-not (Test-Path "node_modules")) { pnpm install --no-frozen-lockfile }
pnpm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Frontend build failed" }
Pop-Location

# 3) Backend exe (output stays at build\bin\, same as v2).
# Build date injected into the exe (shown at the bottom of the Settings dialog).
# Local time (not UTC), ISO with no spaces: safe for go -ldflags -X; the frontend
# renders it as "(<Version> build yyyy-MM-dd HH:mm:ss)" (version via $Version).
$buildDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$ldflags = "-X mdview/internal/app.BuildDate=$buildDate -X mdview/internal/app.BuildVersion=$Version"
$outDir = "$root\build\bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Host "==> go build (desktop,production tags, build $buildDate)"
Push-Location $root
$env:GOOS = "windows"; $env:GOARCH = "amd64"
# v2 embedded icon/version resources via wails build; v3 needs an explicit .syso
# (exe icon + info.json version info; go build links *.syso in the package dir).
# $wails3 was resolved and validated above (bindings step); fail instead of
# skipping: skipping silently produced an iconless exe before.
$syso = "$root\mdview_windows_amd64.syso"
& $wails3 generate syso -arch amd64 -icon build/windows/icon.ico -info build/windows/info.json -manifest build/windows/wails.exe.manifest -out $syso
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $syso)) { Pop-Location; throw "syso generation failed" }
go build -tags "desktop,production" -trimpath -ldflags "-w -s -H windowsgui $ldflags" -o "$outDir\mdview.exe" .
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "go build failed" }
# Without a linked syso the exe has no icon; fail instead of shipping it.
# Go's Windows resources are invisible to .NET VersionInfo, so count icons directly.
if (-not ('MdviewIconProbe' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MdviewIconProbe { [DllImport("shell32.dll", CharSet = CharSet.Auto)] public static extern IntPtr ExtractIconEx(string file, int index, IntPtr large, IntPtr small, uint icons); }'
}
$iconCount = [MdviewIconProbe]::ExtractIconEx("$outDir\mdview.exe", -1, [IntPtr]::Zero, [IntPtr]::Zero, 0).ToInt64()
if ($iconCount -lt 1) { Pop-Location; throw "exe has no icon resource (syso not linked)" }
Remove-Item Env:GOOS, Env:GOARCH -ErrorAction SilentlyContinue
# syso 已链接进 exe，清理生成的中间文件（按通配符删，避免文件名硬编码）
Remove-Item "$root\*.syso" -Force -ErrorAction SilentlyContinue
Pop-Location

Write-Host "==> Output: $outDir\mdview.exe" -ForegroundColor Green

# 4) Package
if ($Package) {
    Write-Host "==> Packaging dist-zip"
    $pkgDir = "$root\..\mdview-dist"
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
    Copy-Item "$outDir\mdview.exe" "$pkgDir\mdview.exe" -Force
    Copy-Item "$root\README.zh-CN.md" "$pkgDir\usage.md" -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path "$pkgDir\*" -DestinationPath "$root\..\mdview-dist.zip" -Force
    Write-Host "==> Output: $root\..\mdview-dist.zip" -ForegroundColor Green
}

Write-Host "==> Done" -ForegroundColor Green
