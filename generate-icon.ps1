# mdview icon generation script (Windows)
# Generates bitmap icon assets from the vector description in tools/genicon
# (same shape as assets/mdview-icon.svg):
#   build/appicon.png          1024x1024, used by Wails for the exe icon
#   build/windows/icon.ico     multi-size ICO for the exe resource and NSIS installer
#   build/mdview.markdown.png  512x512, required by wails.json fileAssociations iconName
#   assets/mdview.ico          kept in the repo for reference
#
# Usage:
#   .\generate-icon.ps1
param()

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host "==> mdview icon assets" -ForegroundColor Cyan

Push-Location $root
go run ./tools/genicon
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { throw "icon generation failed (exit $code)" }

Write-Host "==> Output: build\appicon.png, build\windows\icon.ico, build\mdview.markdown.png" -ForegroundColor Green
Write-Host "==> Done" -ForegroundColor Green
