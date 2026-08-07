param(
  [Parameter(Mandatory=$true)][string]$ProjectId,
  [Parameter(Mandatory=$true)][string]$Email,
  [Parameter(Mandatory=$true)][string]$Password,
  [string]$BaseUrl = "http://localhost:5000",
  [string]$LogPath = "tmp_regenerate_latest.log",
  [string]$ResultPath = "tmp_regenerate_latest_result.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-RunnerLog {
  param([string]$Message)
  Add-Content -Path $LogPath -Value ("{0} {1}" -f (Get-Date).ToString("o"), $Message)
}

try {
  Write-RunnerLog "START project=$ProjectId"
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/auth/login" -ContentType "application/json" -Body $loginBody -WebSession $session | Out-Null
  Write-RunnerLog "LOGIN_OK"

  $csrfResponse = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/auth/csrf-token" -WebSession $session
  $headers = @{ "x-xsrf-token" = $csrfResponse.csrfToken }
  Write-RunnerLog "CSRF_OK"

  $body = @{ replace = $true; sessionGuidance = "" } | ConvertTo-Json
  Write-RunnerLog "GENERATE_START"
  $result = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/projects/$ProjectId/scenarios/generate" -ContentType "application/json" -Body $body -Headers $headers -WebSession $session -TimeoutSec 1800
  $result | ConvertTo-Json -Depth 80 | Set-Content -Path $ResultPath
  Write-RunnerLog "DONE"
  exit 0
} catch {
  Write-RunnerLog ("ERROR " + $_.Exception.Message)
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
    Write-RunnerLog ("ERROR_DETAILS " + $_.ErrorDetails.Message)
  }
  exit 1
}
