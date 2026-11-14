# Starts the whole local system: MongoDB replica (27018) -> backend (4000) -> frontend (8080).
# Safe to run any number of times: a part whose port is already in use is left alone.
# Runs hidden at Windows logon via the "SOULIA Local" scheduled task (see scripts/install-local-autostart.ps1).
# Logs: backend\.local-mongodb\{start-local,backend.*,frontend.*}.log
$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$logDir  = Join-Path $root 'backend\.local-mongodb'
$summary = Join-Path $logDir 'start-local.log'

function Log($msg) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File -FilePath $summary -Append -Encoding utf8 }
function PortOpen([int]$port) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $c.Dispose() }
}
function WaitPort([int]$port, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) { if (PortOpen $port) { return $true }; Start-Sleep -Milliseconds 700 }
  return $false
}

Log '--- start ---'
try {
  # 1. Database (the existing script starts mongod if needed and waits until it is a writable primary)
  & (Join-Path $PSScriptRoot 'start-local-mongodb.ps1')
  Log 'MongoDB 27018: ready'

  # 2. Backend - watch mode, so code edits rebuild by themselves
  if (PortOpen 4000) { Log 'Backend 4000: already running' }
  else {
    Start-Process -FilePath 'npm.cmd' -ArgumentList @('run', 'start:dev') -WorkingDirectory (Join-Path $root 'backend') `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'backend.stdout.log') -RedirectStandardError (Join-Path $logDir 'backend.stderr.log') | Out-Null
    if (WaitPort 4000 180) { Log 'Backend 4000: started' } else { Log 'Backend 4000: NOT up after 180s - see backend.stderr.log / backend.stdout.log' }
  }

  # 3. Frontend
  if (PortOpen 8080) { Log 'Frontend 8080: already running' }
  else {
    Start-Process -FilePath 'node' -ArgumentList @('server.js') -WorkingDirectory (Join-Path $root 'frontend') `
      -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir 'frontend.stdout.log') -RedirectStandardError (Join-Path $logDir 'frontend.stderr.log') | Out-Null
    if (WaitPort 8080 60) { Log 'Frontend 8080: started - http://localhost:8080' } else { Log 'Frontend 8080: NOT up after 60s - see frontend.stderr.log' }
  }
} catch {
  Log ("FAILED: " + $_.Exception.Message)
  throw
}
