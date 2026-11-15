# Rebuilds the ISOLATED e2e stack from scratch (fresh SQLite + seed) and (re)starts it.
# Never touches backend/db.sqlite3 or the dev servers on :3000/:8000.
#   usage:  powershell -File e2e\reset_stack.ps1 -Scratch <dir outside repo>
param([Parameter(Mandatory)][string]$Scratch)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent
$py = Join-Path $repo ".venv\Scripts\python.exe"
$be = Join-Path $Scratch "backend_e2e"

# stop any previous isolated backend on :8001
Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

if (-not (Test-Path $be)) {
  robocopy "$repo\backend" $be /E /XD .pytest_cache __pycache__ /XF db.sqlite3 | Out-Null
  # allow the :3100 e2e frontend origin for CSRF (copy only)
  (Get-Content "$be\config\settings\dev.py") -replace '"http://127.0.0.1:3000",', '"http://127.0.0.1:3000","http://localhost:3100","http://127.0.0.1:3100",' | Set-Content "$be\config\settings\dev.py"
}
Remove-Item "$be\db.sqlite3" -ErrorAction SilentlyContinue
Push-Location $be
& $py manage.py migrate -v0
& $py "$repo\e2e\seed_e2e.py" "$repo\e2e\fixtures.json"
Pop-Location
Start-Process -FilePath $py -ArgumentList "manage.py", "runserver", "127.0.0.1:8001", "--noreload" -WorkingDirectory $be -WindowStyle Hidden
Start-Sleep 4
Write-Host "backend e2e ready on :8001 (frontend copy must be running on :3100 pointing at :8001)"
