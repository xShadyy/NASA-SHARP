param(
    [string]$BindAddress = '127.0.0.1',
    [int]$Port = 8000,
    [string]$Database = '',
    [switch]$Reload
)

$ErrorActionPreference = 'Stop'
$repositoryPath = Split-Path -Parent $PSScriptRoot
$backendPath = Join-Path $repositoryPath 'src/backend_api'
$pythonPath = Join-Path $backendPath '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath -PathType Leaf)) {
    throw 'Install the existing backend virtual environment first; see src/backend_api/README.md.'
}
$runningBackend = $null
try {
    $runningBackend = Invoke-RestMethod -Uri "http://${BindAddress}:$Port/health" -TimeoutSec 2 -ErrorAction Stop
} catch {}
if ($runningBackend -and $runningBackend.status -eq 'ok') {
    if ($runningBackend.implementation -ne 'sharp-backend-2') {
        throw "An older SHARP backend is still running on port $Port. Stop it in its original terminal, then run this command there so its existing server credentials are retained. The running service and stored observations have been preserved."
    }
    throw "SHARP is already running on port $Port. Stop it in its original terminal before starting a replacement. Use -Reload for a development server that reloads backend edits."
}
if ($Database) {
    $env:SHARP_GLOBAL_DB_PATH = [System.IO.Path]::GetFullPath($Database)
} elseif (-not $env:SHARP_GLOBAL_DB_PATH) {
    $env:SHARP_GLOBAL_DB_PATH = Join-Path $backendPath 'data/global-hotspots.sqlite'
}
if (-not $env:SHARP_GLOBAL_INGEST_ENABLED) { $env:SHARP_GLOBAL_INGEST_ENABLED = '1' }
if (-not $env:SHARP_GLOBAL_REFRESH_SECONDS) { $env:SHARP_GLOBAL_REFRESH_SECONDS = '3600' }
if (-not $env:SHARP_GLOBAL_RETAIN_SNAPSHOTS) { $env:SHARP_GLOBAL_RETAIN_SNAPSHOTS = '8' }
if (-not $env:SHARP_FIRMS_HEADROOM) { $env:SHARP_FIRMS_HEADROOM = '1000' }
if (-not $env:SHARP_FIRMS_LOCAL_BUDGET) { $env:SHARP_FIRMS_LOCAL_BUDGET = '3000' }


Write-Host "Starting SHARP from $backendPath"
Write-Host "Global observations database: $env:SHARP_GLOBAL_DB_PATH"
Write-Host 'Stop an older backend on this port with Ctrl+C before starting this one.'
$serverArguments = @('-m', 'uvicorn', 'app:app', '--app-dir', $backendPath, '--host', $BindAddress, '--port', $Port)
if ($Reload) { $serverArguments += @('--reload', '--reload-dir', $backendPath) }
& $pythonPath @serverArguments
exit $LASTEXITCODE
