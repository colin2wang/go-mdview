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

Write-Host "==> mdview build" -ForegroundColor Cyan

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
Write-Host "==> Frontend build (vue-tsc + vite)"
Push-Location "$root\frontend"
if (-not (Test-Path "node_modules")) { pnpm install --no-frozen-lockfile }
pnpm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Frontend build failed" }
Pop-Location

# 3) Backend exe (prefer wails CLI, fall back to go build if missing)
$outDir = "$root\build\bin"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$wails = Get-Command wails -ErrorAction SilentlyContinue
if ($wails) {
    Write-Host "==> wails build (windows/amd64)"
    Push-Location $root
    wails build -s -platform windows/amd64 -webview2 embed -o mdview.exe
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "wails build failed" }
    Pop-Location
} else {
    Write-Host "==> wails CLI not found, falling back to go build (desktop,production tags)"
    Push-Location $root
    $env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
    go build -tags "desktop,production" -ldflags "-w -s -H windowsgui" -o "$outDir\mdview.exe" .
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "go build failed" }
    Remove-Item Env:GOOS, Env:GOARCH, Env:CGO_ENABLED -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host "==> Output: $outDir\mdview.exe" -ForegroundColor Green

# 4) Package
if ($Package) {
    Write-Host "==> Packaging dist-zip"
    $pkgDir = "$root\..\mdview-dist"
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
    Copy-Item "$outDir\mdview.exe" "$pkgDir\mdview.exe" -Force
    Copy-Item "$root\README.zh-CN.md" "$pkgDir\使用说明.md" -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path "$pkgDir\*" -DestinationPath "$root\..\mdview-dist.zip" -Force
    Write-Host "==> Output: $root\..\mdview-dist.zip" -ForegroundColor Green
}

Write-Host "==> Done" -ForegroundColor Green
