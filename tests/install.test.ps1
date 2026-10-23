$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$testRoot = Join-Path $project ('work\install-test-' + [Guid]::NewGuid().ToString('N'))
$mods = Join-Path $testRoot 'AppData\Engine\Mods'
$runtime = Join-Path $testRoot 'Compiler\x86_64-w64-mingw32\bin'
New-Item -ItemType Directory -Path $mods,$runtime -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $testRoot 'windhawk.ini'), "[Storage]`r`nPortable=1`r`nAppDataPath=AppData`r`n")
foreach ($name in @('libc++','libunwind')) { [IO.File]::WriteAllText((Join-Path $runtime "$name.dll"), 'fixture runtime: never executed') }
$config = "[Mod]`r`nLibraryFileName=old.dll`r`nDisabled=1`r`nLoggingEnabled=0`r`nVersion=0.1.0`r`nCustomKey=keep`r`n[Settings]`r`nmaxItems=777`r`nmaxItemSizeMB=24`r`nmaxTotalSizeMB=2048`r`n"
$ini = Join-Path $mods 'winvplus-history-limit.ini'
[IO.File]::WriteAllText($ini, $config, [Text.UnicodeEncoding]::new($false,$true))
& (Join-Path $project 'scripts\install.ps1') -Windhawk $testRoot
$updated = Get-Content -LiteralPath $ini -Raw
foreach ($line in @('Disabled=1','CustomKey=keep','maxItems=777','maxItemSizeMB=24','maxTotalSizeMB=2048','Version=0.2.0')) {
    if (!$updated.Contains($line)) { throw "Lost setting: $line" }
}
$backupFile = Get-ChildItem -LiteralPath (Join-Path $testRoot 'AppData\WinVPlusBackups') -Recurse -Filter 'winvplus-history-limit.ini' | Select-Object -First 1
if (!$backupFile -or (Get-Content -LiteralPath $backupFile.FullName -Raw) -ne $config) { throw 'Exact prior config backup missing.' }
$newIni = Get-Content -LiteralPath (Join-Path $mods 'winvplus-phrases.ini') -Raw
if (!$newIni.Contains('Disabled=0') -or !$newIni.Contains('Version=0.2.0')) { throw 'New mod defaults incorrect.' }
if ($updated -notmatch '(?m)^LibraryFileName=(.+)\r?$') { throw 'Missing library filename.' }
if (!(Test-Path -LiteralPath (Join-Path $mods ('64\' + $Matches[1].Trim())))) { throw 'Installed DLL missing.' }
Write-Output 'PASS: isolated portable install, custom limits and disabled state preserved, exact config backup, versioned artifacts'
