# Try the leaderboard locally without AWS.
#   powershell -ExecutionPolicy Bypass -File test-leaderboard.ps1
#
# Starts the local leaderboard server and launches the app against it using a
# throwaway profile in %TEMP%, so your real streak and answers aren't touched.
# Run it again with -Fresh to start over with a blank test profile.
param(
  [switch]$Fresh,
  [string]$Alias = "",
  [int]$Port = 8787
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$profileDir = Join-Path $env:TEMP "ee-connections-test-profile"
if ($Fresh -and (Test-Path $profileDir)) { Remove-Item -Recurse -Force $profileDir }

$server = Start-Process node -ArgumentList "backend/leaderboard/local-server.mjs", $Port `
  -PassThru -NoNewWindow
Start-Sleep -Seconds 1

try {
  $env:LEADERBOARD_URL = "http://127.0.0.1:$Port"
  $env:EE_USER_DATA_DIR = $profileDir
  if ($Alias) { $env:EE_ALIAS = $Alias }
  Write-Host "Test profile: $profileDir"
  Write-Host "Quit the app from its tray icon to stop the test."
  npx electron .
}
finally {
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
  Remove-Item Env:LEADERBOARD_URL, Env:EE_USER_DATA_DIR, Env:EE_ALIAS -ErrorAction SilentlyContinue
}
