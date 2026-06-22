#Requires -RunAsAdministrator
<#
  Registriert den testo-smart-abruf-Server als geplanten Task (BootTrigger),
  laufend als NT AUTHORITY\NetworkService. Legt den Datenordner an und setzt ACLs.
  Idempotent: ein vorhandener gleichnamiger Task wird zuvor entfernt.
  Dry-Run: -WhatIf zeigt die Aenderungen, ohne sie anzuwenden.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$AppRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$DataDir  = 'C:\ProgramData\TestoSmartAbruf',
  [string]$TaskName = 'TestoSmartAbruf'
)

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $DataDir 'logs'

# 1) Datenordner + Logs anlegen
if ($PSCmdlet.ShouldProcess($DataDir, 'Datenordner anlegen')) {
  New-Item -ItemType Directory -Force -Path $DataDir, $logDir | Out-Null
}

# 2) ACLs: NetworkService = Modify auf Datenordner, ReadExecute auf Code-Ordner.
#    SID *S-1-5-20 statt Name 'NT AUTHORITY\NetworkService' — locale-unabhaengig
#    (auf deutschem Windows heisst das Konto 'NETZWERKDIENST', der Name wuerde scheitern).
if ($PSCmdlet.ShouldProcess($DataDir, 'ACL: NetworkService Modify')) {
  icacls $DataDir /grant '*S-1-5-20:(OI)(CI)M' /T | Out-Null
}
if ($PSCmdlet.ShouldProcess($AppRoot, 'ACL: NetworkService ReadExecute')) {
  icacls $AppRoot  /grant '*S-1-5-20:(OI)(CI)RX' /T | Out-Null
}

# 3) Task-Bestandteile
$action    = New-ScheduledTaskAction -Execute (Join-Path $AppRoot 'deploy\windows\start.cmd')
$trigger   = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\NetworkService' -LogonType ServiceAccount
# -ExecutionTimeLimit ([TimeSpan]::Zero) == PT0S == "kein Limit" (NICHT "sofort beenden").
# Kein -Hidden: eine sichtbare, auditierbare Aufgabe ist EDR-konformer.
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew
$settings.RunOnlyIfNetworkAvailable = $false
$settings.RunOnlyIfIdle = $false

# 4) Idempotent registrieren
if ($PSCmdlet.ShouldProcess($TaskName, 'Scheduled Task registrieren')) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings | Out-Null
  Write-Host "Task '$TaskName' registriert. Manueller Start: schtasks /Run /TN $TaskName"
}
