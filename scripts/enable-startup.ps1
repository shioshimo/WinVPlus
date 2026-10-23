param(
    [Parameter(Mandatory=$true)][string]$Windhawk,
    [switch]$Remove,
    [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = [Security.Principal.WindowsPrincipal]::new($identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (!$admin) { throw 'Run this script once from an administrator PowerShell. No password is stored.' }
$exe = Join-Path (Resolve-Path -LiteralPath $Windhawk).Path 'windhawk.exe'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw "Windhawk not found: $exe" }
$taskName = 'WinVPlus-Windhawk'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and (($existing.Actions.Execute -ne $exe) -or ($existing.Principal.UserId -notin @($identity.Name,$identity.User.Value)))) {
    throw 'A task with this name exists for a different user or executable. It was not changed.'
}
if ($Remove) {
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    Write-Output 'Removed WinVPlus startup task. Mods and saved phrases were kept.'
    return
}
# The native history limit mod needs access to the clipboard service. An
# ordinary Startup-folder shortcut cannot provide that access after logon.
$action = New-ScheduledTaskAction -Execute $exe -Argument '-tray-only' -WorkingDirectory (Split-Path $exe)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity.Name
$trigger.Delay = 'PT15S'
$principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start portable Windhawk for WinVPlus in this user session. No credentials stored.' -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskName $taskName }
Write-Output "Enabled $taskName for $($identity.Name), 15 seconds after logon."
