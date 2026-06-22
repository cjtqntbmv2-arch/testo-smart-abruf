#Requires -RunAsAdministrator
[CmdletBinding(SupportsShouldProcess)]
param([string]$TaskName = 'TestoSmartAbruf')
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Scheduled Task entfernen')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Task '$TaskName' entfernt."
  }
} else {
  Write-Host "Task '$TaskName' existiert nicht."
}
