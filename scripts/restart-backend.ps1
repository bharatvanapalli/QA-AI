$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = if ($env:PORT) { [int]$env:PORT } else { 5000 }
$outLog = Join-Path $repo 'server.out.log'
$errLog = Join-Path $repo 'server.err.log'
$serverEntry = [IO.Path]::GetFullPath((Join-Path $repo 'server\index.js'))

Write-Host "[server:restart] Target: http://localhost:$port"

function Get-PortOwnerPids {
  param([Parameter(Mandatory = $true)][int]$TargetPort)

  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    try {
      return @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
        Where-Object { $_.LocalPort -eq $TargetPort } |
        ForEach-Object { [int]$_.OwningProcess } |
        Where-Object { $_ -gt 0 } |
        Sort-Object -Unique)
    } catch {
      throw "[server:restart] Could not discover the owner of port $TargetPort with Get-NetTCPConnection: $($_.Exception.Message)"
    }
  }

  $netstatLines = @(& netstat.exe -ano -p tcp 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "[server:restart] Could not discover the owner of port $TargetPort with netstat.exe (exit $LASTEXITCODE): $($netstatLines -join ' ')"
  }

  $ownerPids = foreach ($line in $netstatLines) {
    $parts = @(([string]$line -split '\s+') | Where-Object { $_ })
    if ($parts.Count -lt 5 -or $parts[0] -ne 'TCP' -or $parts[3] -ne 'LISTENING') { continue }
    $parsedPort = 0
    $portToken = ($parts[1] -split ':')[-1]
    if ([int]::TryParse($portToken, [ref]$parsedPort) -and $parsedPort -eq $TargetPort) {
      $parsedPid = 0
      if (![int]::TryParse($parts[-1], [ref]$parsedPid)) {
        throw "[server:restart] netstat reported an invalid PID for port ${TargetPort}: $line"
      }
      $parsedPid
    }
  }
  return @($ownerPids | Where-Object { $_ -gt 0 } | Sort-Object -Unique)
}

function Get-VerifiedQaaiNodeProcess {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  try {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
  } catch {
    throw "[server:restart] Could not inspect PID $ProcessId before stopping it: $($_.Exception.Message)"
  }
  if (!$process) {
    throw "[server:restart] Port $port reported PID $ProcessId, but that process could not be inspected. Refusing to kill an unverified process."
  }

  $processName = [string]$process.Name
  $commandLine = [string]$process.CommandLine
  $normalizedCommandLine = $commandLine.Replace('"', '').Replace("'", '').Replace('/', '\').ToLowerInvariant()
  $normalizedServerEntry = $serverEntry.Replace('/', '\').ToLowerInvariant()
  $relativeEntryPattern = '(?:^|\s)(?:\.\\)?server\\index\.js(?:\s|$)'
  $isNode = $processName -match '^(?i:node(?:\.exe)?)$'
  $isQaaiEntry = $normalizedCommandLine.Contains($normalizedServerEntry) `
    -or $normalizedCommandLine -match $relativeEntryPattern
  if (!$isNode -or !$isQaaiEntry) {
    throw "[server:restart] Refusing to stop PID $ProcessId on port ${port}: expected node.exe running this repo's server/index.js, found name='$processName' commandLine='$commandLine'."
  }
  return $process
}

$listeners = @(Get-PortOwnerPids -TargetPort $port)
$verifiedListeners = @()
foreach ($listenerPid in $listeners) {
  $verifiedListeners += Get-VerifiedQaaiNodeProcess -ProcessId $listenerPid
}

foreach ($process in $verifiedListeners) {
  $listenerPid = [int]$process.ProcessId
  Write-Host "[server:restart] Stopping verified QAAI Node PID $listenerPid on port $port"
  try {
    Stop-Process -Id $listenerPid -Force -ErrorAction Stop
  } catch {
    throw "[server:restart] Failed to stop verified QAAI PID ${listenerPid}: $($_.Exception.Message)"
  }
}

$releaseDeadline = (Get-Date).AddSeconds(10)
do {
  $remainingOwners = @(Get-PortOwnerPids -TargetPort $port)
  if ($remainingOwners.Count -eq 0) { break }
  if ((Get-Date) -ge $releaseDeadline) {
    throw "[server:restart] Port $port did not become free after stopping the verified QAAI backend. Remaining owner PID(s): $($remainingOwners -join ', ')."
  }
  Start-Sleep -Milliseconds 200
} while ($true)

try {
  $child = Start-Process -FilePath 'node' `
    -ArgumentList 'server/index.js' `
    -WorkingDirectory $repo `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -WindowStyle Hidden `
    -PassThru `
    -ErrorAction Stop
} catch {
  throw "[server:restart] Failed to launch this repo's backend: $($_.Exception.Message)"
}
Write-Host "[server:restart] Launched PID $($child.Id); waiting for verified listener ownership and health"

$deadline = (Get-Date).AddSeconds(30)
$lastError = $null
$lastOwners = @()
do {
  Start-Sleep -Milliseconds 500
  try {
    $child.Refresh()
  } catch {
    throw "[server:restart] Could not inspect launched PID $($child.Id): $($_.Exception.Message)"
  }
  if ($child.HasExited) {
    $errorTail = if (Test-Path -LiteralPath $errLog) { (Get-Content -LiteralPath $errLog -Tail 40) -join [Environment]::NewLine } else { '(no stderr log)' }
    throw "[server:restart] Launched backend PID $($child.Id) exited with code $($child.ExitCode) before owning port $port and becoming healthy. stderr: $errorTail"
  }

  $lastOwners = @(Get-PortOwnerPids -TargetPort $port)
  if ($lastOwners.Count -gt 0 -and ($lastOwners.Count -ne 1 -or $lastOwners[0] -ne $child.Id)) {
    throw "[server:restart] Port $port is owned by PID(s) $($lastOwners -join ', ') instead of launched PID $($child.Id). Refusing to accept health from a stale or unrelated backend."
  }
  if ($lastOwners.Count -eq 0) {
    $lastError = "Launched PID $($child.Id) is alive but has not started listening on port $port."
    continue
  }

  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
      Write-Host "[server:restart] Backend healthy on verified PID $($child.Id): $($resp.Content)"
      exit 0
    }
    $lastError = "Health endpoint returned HTTP $($resp.StatusCode)."
  } catch {
    $lastError = $_.Exception.Message
  }
} while ((Get-Date) -lt $deadline)

Write-Host "[server:restart] Backend PID $($child.Id) did not become the healthy owner of port $port within 15s. Listener PID(s): $($lastOwners -join ', '). Last error: $lastError"
if (Test-Path -LiteralPath $errLog) {
  Write-Host "[server:restart] Last server.err.log lines:"
  Get-Content -LiteralPath $errLog -Tail 40
}
exit 1
