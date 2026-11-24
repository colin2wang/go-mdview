# mdview build script (run on Windows)
# Usage:
#   .\build.ps1            # incremental build (icons if missing + frontend + backend exe)
#   .\build.ps1 -Clean     # clean before building
#   .\build.ps1 -Package   # build and package dist-zip (with docs/source manifest)
#   .\generate-icon.ps1    # regenerate icon assets only
param(
    [switch]$Clean,
    [switch]$Package
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

# 2) Frontend
Write-Host "==> Frontend build (vue-tsc + vite + sanitize-check)"
Push-Location "$root\frontend"
if (-not (Test-Path "node_modules")) { pnpm install --no-frozen-lockfile }
pnpm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Frontend build failed" }
Pop-Location

# 3) Backend exe (output stays at build\bin\, same as v2).
# Build date injected into the exe (shown at the bottom of the Settings dialog).
# Local time (not UTC), ISO with no spaces: safe for go -ldflags -X; the frontend
# renders it as "(build yyyy-MM-dd HH:mm:ss)".
$buildDate = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
$ldflags = "-X mdview/internal/app.BuildDate=$buildDate"
$outDir = "$root\build\bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Write-Host "==> go build (desktop,production tags, build $buildDate)"
Push-Location $root
$env:GOOS = "windows"; $env:GOARCH = "amd64"
# v2 的 wails build 内置了图标/版本资源嵌入；v3 需在编译前生成 .syso
# （exe 图标 + info.json 版本信息，go build 自动链接包目录下的 *.syso）
$wails3 = Get-Command wails3 -ErrorAction SilentlyContinue
if ($wails3) {
    wails3 generate syso -arch amd64 -icon build/windows/icon.ico -info build/windows/info.json -manifest build/windows/wails.exe.manifest -out mdview_windows_amd64.syso
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "syso generation failed" }
} else {
    Write-Host "==> wails3 CLI not found, skip .syso (exe will have no icon)" -ForegroundColor Yellow
}
go build -tags "desktop,production" -trimpath -ldflags "-w -s -H windowsgui $ldflags" -o "$outDir\mdview.exe" .
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "go build failed" }
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
