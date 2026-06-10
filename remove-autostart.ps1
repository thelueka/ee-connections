# EE Connections - Remove Auto-start
# Run this script to stop EE Connections from launching on login.

$shortcutName = "EE Connections.lnk"
$startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupFolder $shortcutName

if (Test-Path $shortcutPath) {
    Remove-Item $shortcutPath -Force
    Write-Host "EE Connections auto-start has been removed." -ForegroundColor Green
} else {
    Write-Host "No auto-start shortcut found. Nothing to remove." -ForegroundColor Yellow
}
