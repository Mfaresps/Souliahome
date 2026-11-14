# Stops the local backend (4000) and frontend (8080). MongoDB 27018 is left running
# unless -Mongo is given. Use before pulling a big change, or to free the ports.
param([switch]$Mongo)
$ports = @(4000, 8080) + $(if ($Mongo) { @(27018) } else { @() })
foreach ($port in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"
    # `nest start --watch` keeps a parent node/npm alive; stop the whole tree.
    & taskkill.exe /PID $c.OwningProcess /T /F | Out-Null
    Write-Output "Stopped port $port ($($p.Name))"
  }
  if (-not $conns) { Write-Output "Port ${port}: nothing running" }
}
