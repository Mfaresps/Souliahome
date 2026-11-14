# Registers "SOULIA Local": runs scripts\start-local.ps1 hidden every time you log in to Windows.
# Per-user task, no admin rights needed. Remove with:  .\scripts\install-local-autostart.ps1 -Remove
param([switch]$Remove)
$name = 'SOULIA Local'
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed scheduled task '$name'."
  return
}
$script  = Join-Path $PSScriptRoot 'start-local.ps1'
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$trigger.Delay = 'PT20S'   # let the network and the MongoDB service settle first
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Starts SOULIA locally (MongoDB 27018, backend 4000, frontend 8080) at logon.' -Force | Out-Null
Write-Output "Registered '$name' - it runs at every logon. Run it now with: Start-ScheduledTask -TaskName '$name'"
