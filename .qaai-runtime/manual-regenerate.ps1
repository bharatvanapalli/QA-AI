$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\2461898\Downloads\qaai_fixed\qaai_fixed\qaai_fixed'
Set-Location $repo
$base = 'http://localhost:5000'
$log = Join-Path $repo '.qaai-runtime\manual-regenerate.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
"[$(Get-Date -Format o)] starting manual backend regeneration" | Out-File -FilePath $log -Encoding utf8
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$loginBody = @{ email = 'bharatvanapalli8@gmail.com'; password = 'Bharat@123' } | ConvertTo-Json
$login = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/auth/login" -Method POST -ContentType 'application/json' -Body $loginBody -WebSession $session -TimeoutSec 30
"[$(Get-Date -Format o)] login status $($login.StatusCode)" | Add-Content $log
$csrf = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/auth/csrf-token" -Method GET -WebSession $session -TimeoutSec 30
$csrfJson = $csrf.Content | ConvertFrom-Json
$headers = @{ 'x-xsrf-token' = $csrfJson.csrfToken }
"[$(Get-Date -Format o)] csrf issued" | Add-Content $log
$body = @{ replace = $true; forceAtlasRefresh = $false; idempotencyKey = "manual-v14-$(Get-Date -Format yyyyMMddHHmmss)" } | ConvertTo-Json
try {
  $resp = Invoke-WebRequest -UseBasicParsing -Uri "$base/api/projects/6a68412b-2d91-4ec5-b15a-2e1bf8fd744e/scenarios/generate" -Method POST -ContentType 'application/json' -Headers $headers -Body $body -WebSession $session -TimeoutSec 900
  "[$(Get-Date -Format o)] generate status $($resp.StatusCode)" | Add-Content $log
  $resp.Content | Add-Content $log
} catch {
  "[$(Get-Date -Format o)] generate failed: $($_.Exception.Message)" | Add-Content $log
  if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message | Add-Content $log }
  exit 1
}
