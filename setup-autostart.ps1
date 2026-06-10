# EE Connections - Auto-start Setup
# Run this script once to make EE Connections launch on login.
# No admin privileges required.

$appPath = Join-Path $PSScriptRoot "node_modules\electron\dist\electron.exe"
$appDir = $PSScriptRoot
$shortcutName = "EE Connections.lnk"
$startupFolder = [System.IO.Path]::Combine($env:APPDATA, "Microsoft\Windows\Start Menu\Programs\Startup")
$shortcutPath = Join-Path $startupFolder $shortcutName

# Verify electron exists
if (-not (Test-Path $appPath)) {
    Write-Host "ERROR: electron.exe not found. Run 'npm install' first." -ForegroundColor Red
    exit 1
}

# Create shortcut in Startup folder
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $appPath
$shortcut.Arguments = "."
$shortcut.WorkingDirectory = $appDir
$shortcut.Description = "EE Connections Daily Trivia"
$shortcut.Save()

Write-Host ""
Write-Host "Done! EE Connections will now launch automatically when you log in." -ForegroundColor Green
Write-Host "Shortcut created at: $shortcutPath" -ForegroundColor Gray
Write-Host "To remove: run remove-autostart.ps1" -ForegroundColor Gray
