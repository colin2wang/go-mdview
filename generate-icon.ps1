# mdview icon generation script (Windows)
# Generates bitmap icon assets from the vector description in tools/genicon
# (same shape as assets/mdview-icon.svg):
#   build/appicon.png          1024x1024, used by Wails for the exe icon
#   build/windows/icon.ico     multi-size ICO for the exe resource (syso) and installer
#   build/mdview.markdown.png  512x512, source for the .md file-association icon
#   assets/mdview.ico          kept in the repo for reference
#
# wails3 task build / build:production runs syso generation from build/windows/icon.ico;
# this script is for manual refresh of the icon assets only.
#
# Usage:
#   .\generate-icon.ps1
#   .\generate-icon.ps1 -Wails   # refresh platform icons via wails3 CLI
param(
    [switch]$Wails
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "==> mdview icon assets" -ForegroundColor Cyan

Push-Location $root
go run ./tools/genicon
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "icon generation failed (exit $code)" }

# Optionally refresh platform assets (ico/icns) via the wails3 CLI
if ($Wails) {
    $wails3 = Get-Command wails3 -ErrorAction SilentlyContinue
    if ($wails3) {
        wails3 generate icons `
            -input build/appicon.png `
            -windowsfilename build/windows/icon.ico
        if ($LASTEXITCODE -ne 0) { throw "wails3 generate icons failed" }
    } else {
        Write-Host "==> wails3 CLI not found, skip platform icon refresh" -ForegroundColor Yellow
    }
}

Write-Host "==> Output: build\appicon.png, build\windows\icon.ico, build\mdview.markdown.png" -ForegroundColor Green
Write-Host "==> Done" -ForegroundColor Green
