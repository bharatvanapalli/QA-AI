param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = 'Stop'
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$base = 'http://localhost:5000'

try {
  $loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json
  Invoke-RestMethod -Method Post -Uri "$base/api/auth/login" -Body $loginBody -ContentType 'application/json' -WebSession $session | Out-Null
  $xsrf = ($session.Cookies.GetCookies($base) | Where-Object Name -eq 'XSRF-TOKEN' | Select-Object -First 1).Value
  $guidance = @(
    '[GENERATION MODE - Regression]',
    'Generate a fresh regression suite from the uploaded user stories and approved project test data.',
    'Do not invent generic OrangeHRM coverage just because the public demo app is known.',
    'Every executable input step must bind to mapped test data or approved credentials.',
    'Every case must have a clean session/login rule, precise expected result, and evidence-ready assertion.',
    'Prefer complete end-to-end business workflows over tiny disconnected button checks.'
  ) -join "`n"
  $body = @{
    replace = $true
    forceAtlasRefresh = $false
    generationMode = 'regression'
    sessionGuidance = $guidance
  } | ConvertTo-Json -Depth 8
  $startedAt = Get-Date -Format o
  @{ status = 'started'; startedAt = $startedAt } | ConvertTo-Json | Set-Content -Path $OutFile -Encoding UTF8
  $response = Invoke-RestMethod -Method Post -Uri "$base/api/projects/$ProjectId/scenarios/generate" -Body $body -ContentType 'application/json' -WebSession $session -Headers @{ 'X-XSRF-TOKEN' = $xsrf } -TimeoutSec 1800
  @{ status = 'complete'; startedAt = $startedAt; completedAt = (Get-Date -Format o); response = $response } | ConvertTo-Json -Depth 50 | Set-Content -Path $OutFile -Encoding UTF8
} catch {
  @{ status = 'failed'; completedAt = (Get-Date -Format o); error = $_.Exception.Message } | ConvertTo-Json -Depth 10 | Set-Content -Path $OutFile -Encoding UTF8
  exit 1
}
