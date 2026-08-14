Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$baseUrl = 'https://api-loadtest.sgsseguranca.com.br'
$runId = "sgs-controlled-login-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"

foreach ($name in 'LOADTEST_ADMIN_CPF', 'LOADTEST_ADMIN_PASSWORD', 'LOADTEST_PROXY_KEY') {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "missing secure environment value: $name"
  }
}

$cpf = [Environment]::GetEnvironmentVariable('LOADTEST_ADMIN_CPF')
$password = [Environment]::GetEnvironmentVariable('LOADTEST_ADMIN_PASSWORD')
$proxyKey = [Environment]::GetEnvironmentVariable('LOADTEST_PROXY_KEY')
$expectedUserId = [Environment]::GetEnvironmentVariable('LOADTEST_USER_ID')
$expectedCompanyId = [Environment]::GetEnvironmentVariable('LOADTEST_COMPANY_ID')

$headers = @{
  Accept = 'application/json'
  'X-Loadtest-Key' = $proxyKey
  'X-Test-Run-ID' = $runId
}

$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$csrfResponse = Invoke-WebRequest `
  -Uri "$baseUrl/auth/csrf" `
  -Method Get `
  -Headers $headers `
  -WebSession $session `
  -SkipHttpErrorCheck

$csrfJson = $csrfResponse.Content | ConvertFrom-Json
$csrfToken = [string]$csrfJson.csrfToken
$csrfCookies = @($session.Cookies.GetCookies([Uri]$baseUrl) | Where-Object { $_.Name -eq 'csrf-token' })
$activeCsrfCookies = @($csrfCookies | Where-Object { -not $_.Expired -and $_.Value })
$activeCsrf = if ($activeCsrfCookies.Count -eq 1) { $activeCsrfCookies[0] } else { $null }

$cookieJarEnabled = $true
$csrfCookieActive = $null -ne $activeCsrf
$csrfHeaderCookieMatch = $csrfCookieActive -and $csrfToken -eq $activeCsrf.Value

Write-Output "X_TEST_RUN_ID=$runId"
Write-Output "CSRF_STATUS=$([int]$csrfResponse.StatusCode)"
Write-Output "COOKIE_JAR_ENABLED=$cookieJarEnabled"
Write-Output "CSRF_COOKIE_ACTIVE=$csrfCookieActive"
Write-Output "CSRF_HEADER_COOKIE_MATCH=$csrfHeaderCookieMatch"

if (-not $csrfCookieActive -or [string]::IsNullOrWhiteSpace($csrfToken) -or -not $csrfHeaderCookieMatch) {
  Write-Output 'LOGIN_STATUS=NOT_RUN'
  Write-Output 'VALIDATE_USER_REACHED=unknown'
  Write-Output 'ACCESS_TOKEN_PRESENT=false'
  Write-Output 'AUTH_ME_STATUS=SKIPPED'
  Write-Output 'SYNTHETIC_USER_MATCH=false'
  Write-Output 'SYNTHETIC_TENANT_MATCH=false'
  exit 2
}

$loginBody = @{ cpf = $cpf; password = $password } | ConvertTo-Json -Compress
$loginHeaders = @{
  Accept = 'application/json'
  'Content-Type' = 'application/json'
  'X-Loadtest-Key' = $proxyKey
  'X-Test-Run-ID' = $runId
  'x-csrf-token' = $csrfToken
}

$loginResponse = Invoke-WebRequest `
  -Uri "$baseUrl/auth/login" `
  -Method Post `
  -Headers $loginHeaders `
  -Body $loginBody `
  -WebSession $session `
  -SkipHttpErrorCheck

$loginJson = $loginResponse.Content | ConvertFrom-Json
$accessToken = [string]$loginJson.accessToken
$loginPassed = [int]$loginResponse.StatusCode -in @(200, 201) -and -not [string]::IsNullOrWhiteSpace($accessToken)

Write-Output "LOGIN_STATUS=$([int]$loginResponse.StatusCode)"
Write-Output "VALIDATE_USER_REACHED=$([int]$loginResponse.StatusCode -ne 403)"
Write-Output "ACCESS_TOKEN_PRESENT=$(-not [string]::IsNullOrWhiteSpace($accessToken))"

if (-not $loginPassed) {
  Write-Output 'AUTH_ME_STATUS=SKIPPED'
  Write-Output 'SYNTHETIC_USER_MATCH=false'
  Write-Output 'SYNTHETIC_TENANT_MATCH=false'
  exit 3
}

$meHeaders = @{
  Accept = 'application/json'
  Authorization = "Bearer $accessToken"
  'X-Loadtest-Key' = $proxyKey
  'X-Test-Run-ID' = $runId
}
$meResponse = Invoke-WebRequest `
  -Uri "$baseUrl/auth/me" `
  -Method Get `
  -Headers $meHeaders `
  -WebSession $session `
  -SkipHttpErrorCheck
$meJson = $meResponse.Content | ConvertFrom-Json
$meUser = $meJson.user

Write-Output "AUTH_ME_STATUS=$([int]$meResponse.StatusCode)"
Write-Output "SYNTHETIC_USER_MATCH=$([string]$meUser.id -eq [string]$expectedUserId)"
Write-Output "SYNTHETIC_TENANT_MATCH=$([string]$meUser.company_id -eq [string]$expectedCompanyId)"
